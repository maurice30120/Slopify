import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, readFile, writeFile, rename, readdir, access } from 'node:fs/promises';
import * as path from 'node:path';
import { createNodeSubprocessExecutor, type SubprocessExecutor, type TaskDiagnostic, type TaskExecutor, type TaskExecutionRequest, type TaskExecutionResult, type TaskExecutionResource, type TaskAgent } from '@slopify/execution';
import type { LocalAgentRunRequest, LocalAgentRunResult, LocalAgentRunner } from '@slopify/execution';
export type { LocalAgentRunRequest, LocalAgentRunResult, LocalAgentRunner } from '@slopify/execution';
import { runPiRpcWorkflow, type PiReviewOutcome, type PiRpcWorkflowResult } from '@slopify/agent-pi';
import type { PiRpcChannel, PiRpcChannelFactory } from '@slopify/agent-pi';
import { readLocalProcessIdentity, inspectLocalProcessGroup, type LocalProcessIdentity } from './localProcessIdentity.js';
export { readLocalProcessIdentity, inspectLocalProcess, inspectLocalProcessGroup, isLocalProcessAlive } from './localProcessIdentity.js';
export type { LocalProcessIdentity, LocalProcessLiveness } from './localProcessIdentity.js';


import { agentOutcomeDiagnostics } from '@slopify/execution';

export interface LocalTaskExecutorOptions {
  executor?: SubprocessExecutor;
  agentRunner?: LocalAgentRunner;
}

/**
 * Exécuteur local : chaque tentative travaille dans son clone privé sur la machine,
 * sans Docker ni sbx. Les preuves, checkpoints et rapports suivent le même contrat
 * que l'exécution sandbox ; la ressource signalée décrit le clone et le processus local.
 */
export class LocalTaskExecutor implements TaskExecutor {
  private readonly executor: SubprocessExecutor;
  private readonly runner: LocalAgentRunner;

  private runId?: string;

  constructor(options: LocalTaskExecutorOptions = {}) {
    this.executor = options.executor ?? createNodeSubprocessExecutor();
    this.runner = options.agentRunner ?? createLocalAgentRunner();
  }

  async prepareRun(request: { runId: string }): Promise<void> {
    if (this.runId && this.runId !== request.runId) throw new Error('A task executor belongs to one batch.');
    this.runId = request.runId;
  }

  private git(cwd: string, args: string[], signal?: AbortSignal) {
    return this.executor({ command: 'git', args, cwd, stdin: 'ignore', signal });
  }

  private async requireGit(cwd: string, args: string[], signal: AbortSignal | undefined): Promise<string> {
    const result = await this.git(cwd, args, signal);
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    return result.stdout;
  }

  async execute(request: TaskExecutionRequest): Promise<TaskExecutionResult> {
    await mkdir(request.resultDirectory, { recursive: true, mode: 0o700 });
    const stdoutPath = path.join(request.resultDirectory, 'stdout.log');
    const stderrPath = path.join(request.resultDirectory, 'stderr.log');
    const reportPath = path.join(request.resultDirectory, 'report.md');
    const eventsPath = path.join(request.resultDirectory, 'commands.jsonl');
    await Promise.all([stdoutPath, stderrPath, eventsPath].map(p => writeFile(p, '', { mode: 0o600 })));
    const logged: SubprocessExecutor = async subprocess => {
      appendFileSync(eventsPath, JSON.stringify({ type: 'start', command: subprocess.command, args: subprocess.args, time: new Date().toISOString() }) + '\n');
      const seen = { stdout: false, stderr: false };
      const result = await this.executor({ ...subprocess, onOutput: (stream, chunk) => {
        seen[stream] = true;
        appendFileSync(stream === 'stdout' ? stdoutPath : stderrPath, chunk);
        subprocess.onOutput?.(stream, chunk);
      } });
      if (!seen.stdout) appendFileSync(stdoutPath, result.stdout);
      if (!seen.stderr) appendFileSync(stderrPath, result.stderr);
      appendFileSync(eventsPath, JSON.stringify({ type: 'end', exitCode: result.exitCode, time: new Date().toISOString() }) + '\n');
      return result;
    };
    const diagnostics: TaskDiagnostic[] = [];
    let resource: TaskExecutionResource | undefined;
    let checkpoint: TaskExecutionResult['checkpoint'];
    // Chaque tentative locale travaille dans le clone privé fourni par le moteur de lots
    // (workspaces/<attemptId>), démarré sur sa base épinglée ; le workspace utilisateur
    // n'est jamais touché.
    const clonePath = request.workspacePath;
    const contextPath = path.join(request.resultDirectory, 'context');
    let attemptIdentity: LocalProcessIdentity | undefined;
    try {
      const head = (await this.requireGit(clonePath, ['rev-parse', 'HEAD'], request.signal)).trim();
      if (head !== request.taskBaseCommit) throw new Error(`Clone baseline mismatch: expected ${request.taskBaseCommit}, got ${head}.`);
      resource = {
        sandboxName: request.attemptId,
        worktreePath: clonePath,
        inspectCommand: ['local', 'clone', clonePath],
        diagnosticsDirectory: request.resultDirectory,
      };
      await request.onResource?.(resource);
      await mkdir(contextPath, { recursive: true });
      const harness = [
        'Read the full frozen spec: ' + path.join(contextPath, 'spec.md'),
        'Task baseline: ' + request.taskBaseCommit + '; run baseline: ' + request.runBaseCommit + '.',
        'Execution is local on the host machine; no Docker sandbox is used for this attempt.',
        'Use the official implement skill and its referenced resources. The ticket prompt is unchanged.',
        request.agent === 'pi'
          ? 'TDD interfaces in the ticket are approved. Follow one red/green behavior at a time, targeted validation, full suite, then commit. The workflow runs an independent per-ticket Standards/Spec review after your commit.'
          : 'TDD interfaces in the ticket are approved. Follow one red/green behavior at a time, targeted validation, full suite, then commit. Independent per-ticket Standards/Spec reviews are not required; the batch performs one final combined review of the integration branch.',
        'Read all applicable AGENTS.md and repository standards before implementation.',
        'Actual live raw execution traces: ' + stdoutPath + ' and ' + stderrPath + '. Observed harness commands: ' + eventsPath + '. Keep them intact as evidence for the final combined review.',
        'Uncommitted user changes are excluded from this private checkout.',
        'End your final assistant message with exactly one standalone line: SLOPIFY_RESULT={"status":"succeeded"} or SLOPIFY_RESULT={"status":"failed","reason":"concrete remaining blocker"}.',
        'Report failed if final required validations fail or work is incomplete. Expected intermediate TDD red tests are not final failures. A process exit code of zero does not establish task success. Missing or invalid verdicts fail the task. Never put this marker in reviewer reports or intermediate messages.',
      ].join('\n');
      await writeFile(path.join(contextPath, 'spec.md'), await readFile(request.specFile, 'utf8'), { mode: 0o600 });
      await writeFile(path.join(contextPath, 'harness.txt'), harness, { mode: 0o600 });
      let streamed = { stdout: false, stderr: false };
      const stream = (target: 'stdout' | 'stderr', chunk: string) => {
        streamed[target] = true;
        appendFileSync(target === 'stdout' ? stdoutPath : stderrPath, chunk);
      };
      const onProcessSpawn = async (identity: LocalProcessIdentity) => {
        await request.onProcessSpawn?.(identity);
        attemptIdentity ??= identity;
      };
      const run = await this.runner({ ...request, workspacePath: clonePath, logged, contextPath, onProcessSpawn, stream });
      diagnostics.push(...run.diagnostics);
      await writeFile(reportPath, run.report, { mode: 0o600 });
      if (run.exitCode !== 0 || diagnostics.some(d => d.code !== 'codex_evidence_unavailable')) {
        return { exitCode: run.exitCode || 1, stdoutPath, stderrPath, reportPath, resource, diagnostics, ...(attemptIdentity ? { processIdentity: attemptIdentity } : {}) };
      }
      // Checkpoint durable depuis le clone privé, sans toucher au workspace utilisateur.
      await this.requireGit(clonePath, ['add', '--all'], request.signal);
      await this.requireGit(clonePath, [
        '-c', 'user.name=Slopify', '-c', 'user.email=slopify@localhost', '-c', 'commit.gpgsign=false',
        'commit', '--allow-empty', '--no-verify',
        '-m', 'chore(slopify): create Agent Checkpoint',
        '-m', `Slopify-Run: ${request.runId}`,
        '-m', `Slopify-Task: ${request.taskId}`,
        '-m', `Slopify-Attempt: ${request.attemptId}`,
      ], request.signal);
      const commit = (await this.requireGit(clonePath, ['rev-parse', 'HEAD'], request.signal)).trim();
      const ancestry = await this.git(clonePath, ['merge-base', '--is-ancestor', request.taskBaseCommit, commit], request.signal);
      if (ancestry.exitCode !== 0) throw new Error('Checkpoint does not descend from the task baseline.');
      const checkpointRef = `refs/slopify/checkpoints/${request.attemptId}`;
      await this.requireGit(clonePath, ['update-ref', checkpointRef, commit], request.signal);
      const bundlePath = path.join(request.resultDirectory, 'checkpoint.bundle');
      const bundled = await this.git(clonePath, ['bundle', 'create', bundlePath, checkpointRef], request.signal);
      if (bundled.exitCode !== 0) throw new Error('Cannot persist the checkpoint bundle: ' + bundled.stderr);
      checkpoint = { commit, bundlePath };
      const receipt = path.join(request.resultDirectory, 'result.json');
      await writeFile(receipt + '.tmp', JSON.stringify({ runId: request.runId, taskId: request.taskId, attemptId: request.attemptId, taskBaseCommit: request.taskBaseCommit, completedAt: new Date().toISOString(), exitCode: 0, checkpoint, resource, stdoutPath, stderrPath, reportPath, diagnostics }, null, 2), { mode: 0o600 });
      await rename(receipt + '.tmp', receipt);
      return { exitCode: 0, checkpoint, stdoutPath, stderrPath, reportPath, resource, diagnostics, ...(attemptIdentity ? { processIdentity: attemptIdentity } : {}) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push({ code: request.signal?.aborted ? 'interrupted' : 'execution_failed', message });
      appendFileSync(stderrPath, message + '\n');
      await writeFile(reportPath, 'Execution failed: ' + message, { mode: 0o600 });
      return { exitCode: 1, checkpoint, stdoutPath, stderrPath, reportPath, resource, diagnostics, ...(attemptIdentity ? { processIdentity: attemptIdentity } : {}) };
    }
  }

  async close(): Promise<void> {}

  /** Nettoie un clone intégré avec succès ; les clones en échec restent inspectables. */
  async cleanup(resource: TaskExecutionResource): Promise<void> {
    if (!resource.worktreePath) return;
    const result = await this.executor({ command: 'git', args: ['-C', resource.worktreePath, 'rev-parse', '--git-dir'], cwd: resource.diagnosticsDirectory ?? process.cwd(), stdin: 'ignore' });
    if (result.exitCode !== 0) return;
    await this.executor({ command: 'rm', args: ['-rf', resource.worktreePath], cwd: resource.diagnosticsDirectory ?? process.cwd(), stdin: 'ignore' });
    if (resource.diagnosticsDirectory) appendFileSync(path.join(resource.diagnosticsDirectory, 'commands.jsonl'), JSON.stringify({ type: 'cleanup', args: ['rm', '-rf', resource.worktreePath] }) + '\n');
  }
}


function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export async function nativeCodexSessionFailures(directory: string): Promise<TaskDiagnostic[]> {
  const diagnostics: TaskDiagnostic[] = [];
  try {
    for (const file of await readdir(directory, { recursive: true })) {
      if (!file.endsWith('.jsonl')) continue;
      const calls = new Map<string, string>();
      for (const line of (await readFile(path.join(directory, file), 'utf8')).split(/\r?\n/)) {
        let event: Record<string, unknown> | undefined;
        try { event = object(JSON.parse(line)); } catch { continue; }
        const payload = object(event?.payload);
        if (!payload) continue;
        if (payload.type === 'function_call' && payload.namespace === 'collaboration' && typeof payload.call_id === 'string' && typeof payload.name === 'string') {
          calls.set(payload.call_id, payload.name);
        }
        if (payload.type !== 'function_call_output' || typeof payload.call_id !== 'string' || typeof payload.output !== 'string') continue;
        const tool = calls.get(payload.call_id);
        if (!tool) continue;
        let output: Record<string, unknown> | undefined;
        try { output = object(JSON.parse(payload.output)); } catch { continue; }
        if (!output) continue;
        if (output.error) diagnostics.push({ code: 'codex_subagent_error', message: tool + ': ' + JSON.stringify(output.error) });
        if (tool === 'list_agents' && Array.isArray(output.agents)) {
          for (const entry of output.agents) {
            const agent = object(entry);
            const status = object(agent?.agent_status);
            if (agent?.agent_status === 'errored' || agent?.agent_status === 'failed' || status?.errored || status?.failed) {
              diagnostics.push({ code: 'codex_subagent_error', message: String(agent?.agent_name ?? 'Codex reviewer') + ': ' + JSON.stringify(agent?.agent_status) });
            }
          }
        }
      }
    }
  } catch (error) {
    diagnostics.push({ code: 'codex_evidence_unavailable', message: 'Cannot read persisted reviewer rollouts: ' + String(error) });
  }
  return diagnostics;
}

/** Signal only a POSIX process group assigned to this agent attempt. */
function signalAttemptGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
  try { process.kill(-pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

async function waitForAttemptGroupExit(pid: number, maxWaitMs: number): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const status = await inspectLocalProcessGroup(pid);
    if (status === 'dead') return true;
    if (status === 'unknown') return false;
    await sleep(80);
  }
  return (await inspectLocalProcessGroup(pid)) === 'dead';
}

/** Final guard after agent completion: leaked descendants fail the attempt. */
async function finishAttemptGroup(pid: number): Promise<boolean> {
  if (process.platform === 'win32') return true;
  const status = await inspectLocalProcessGroup(pid);
  if (status === 'dead') return true;
  if (status === 'unknown') return false;
  signalAttemptGroup(pid, 'SIGTERM');
  if (await waitForAttemptGroupExit(pid, 800)) return true;
  // Never signal a group whose ownership cannot be checked.
  if (await inspectLocalProcessGroup(pid) !== 'alive') return false;
  signalAttemptGroup(pid, 'SIGKILL');
  return waitForAttemptGroupExit(pid, 800);
}

/**
 * Every Pi/Codex process starts as leader of its own POSIX group. Ctrl-C/abort
 * stops the group, not only the direct agent. Other attempts stay isolated.
 */
async function spawnLocalAgent(request: LocalAgentRunRequest, command: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (request.signal?.aborted) return { exitCode: 1, stdout: '', stderr: 'Attempt interrupted before agent start.' };
  const startedAtIso = new Date().toISOString();
  const isolated = process.platform !== 'win32';
  const child = spawn(command, args, { cwd: request.workspacePath, stdio: ['ignore', 'pipe', 'pipe'], detached: isolated });
  const pid = child.pid;
  let stdout = '';
  let stderr = '';
  // Install handlers immediately, before any asynchronous OS inspection.
  const completion = new Promise<number>((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; request.stream('stdout', chunk); });
    child.stderr.on('data', chunk => { stderr += chunk; request.stream('stderr', chunk); });
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    if (!pid) return;
    if (!isolated) { child.kill('SIGTERM'); return; }
    signalAttemptGroup(pid, 'SIGTERM');
    // A child holding inherited stdout pipes may prevent 'close' until killed.
    escalation = setTimeout(() => {
      void inspectLocalProcessGroup(pid).then(status => {
        if (status === 'alive') signalAttemptGroup(pid, 'SIGKILL');
      }).catch(() => { /* Uncertain ownership must not cause a blind kill. */ });
    }, 1200);
    escalation.unref();
  };
  request.signal?.addEventListener('abort', onAbort, { once: true });
  if (request.signal?.aborted) onAbort();
  try {
    if (pid) {
      const identity = await readLocalProcessIdentity(pid, [command, ...args].join(' '), startedAtIso);
      if (isolated) identity.processGroupId = pid;
      await request.onProcessSpawn?.(identity);
    }
    const exitCode = await completion;
    const stopped = pid ? await finishAttemptGroup(pid) : true;
    if (!stopped) {
      return { exitCode: 1, stdout, stderr: stderr + '\\nLocal agent descendants were not confirmed stopped; inspect the retained attempt.' };
    }
    return { exitCode, stdout, stderr };
  } catch (error) {
    // Failure to durably record identity must not leave an unmanaged agent running.
    onAbort();
    await completion.catch(() => undefined);
    if (pid) await finishAttemptGroup(pid);
    throw error;
  } finally {
    if (escalation) clearTimeout(escalation);
    request.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Pi local : même workflow RPC natif qu'en sandbox — session implémenteur persistante,
 * reviewer indépendant neuf à chaque passage — avec la configuration personnelle
 * native de l'utilisateur (fournisseur, modèle, identifiants) : Slopify n'impose
 * pas Mistral et ne réécrit jamais la configuration de l'utilisateur. L'extension
 * officielle subagent est requise explicitement ; son absence échoue avec un
 * diagnostic, sans repli silencieux en revue inline ni en mode print.
 */
async function runPiLocal(request: LocalAgentRunRequest): Promise<LocalAgentRunResult> {
  const extension = await discoverLocalSubagentExtension(request);
  if (!extension) {
    return { exitCode: 1, report: '', diagnostics: [{ code: 'pi_subagent_unavailable',
      message: 'The local Pi workflow requires the official subagent extension (examples/extensions/subagent with its agents.ts) installed at ~/.pi/agent/extensions/subagent/, .pi/extensions/subagent/ in the task clone, or in the npm global @earendil-works/pi-coding-agent package. Independent Standards/Spec reviews cannot run inline.' }] };
  }
  const configDirectory = path.join(request.contextPath, 'pi-config');
  await mkdir(path.join(configDirectory, 'agents'), { recursive: true, mode: 0o700 });
  // Le reviewer local reçoit une copie de la configuration de l'utilisateur (lecture seule) : ses sous-agents standards/spec restent disponibles sans jamais réécrire l'original.
  const userModels = path.join(homedir(), '.pi', 'agent', 'models.json');
  if (await readable(userModels)) {
    await writeFile(path.join(configDirectory, 'models.json'), await readFile(userModels, 'utf8'), { mode: 0o600 });
  }
  await writeFile(path.join(configDirectory, 'reviewer.txt'), localReviewerHarness(request));
  for (const axis of ['standards', 'spec'] as const) {
    await writeFile(path.join(configDirectory, 'agents', `${axis}.md`), localReviewerRole(axis, request));
  }
  const extensionArgs = extension.explicit ? ['--extension', extension.path] : [];
  const openChannel: PiRpcChannelFactory = session => spawnLocalRpcChannel(request,
    ['--mode', 'rpc', '--no-session', '--append-system-prompt',
      path.join(session.role === 'implementer' ? request.contextPath : configDirectory, session.role === 'implementer' ? 'harness.txt' : 'reviewer.txt'),
      ...extensionArgs],
    session.role === 'reviewer' ? { PI_CODING_AGENT_DIR: configDirectory } : undefined, session);
  const workflow = await runPiRpcWorkflow({
    runId: request.runId, taskId: request.taskId, attemptId: request.attemptId,
    resultDirectory: request.resultDirectory, signal: request.signal,
    openChannel,
    initialMessage: request.prompt,
    reviewMessage: (cycle, previous) => localReviewMessage(request, cycle, previous),
    correctionMessage: localCorrectionMessage,
    verifyReadyForReview: async () => {
      const status = await request.logged({ command: 'git', args: ['status', '--porcelain', '--untracked-files=all'], cwd: request.workspacePath, stdin: 'ignore', signal: request.signal });
      if (status.exitCode !== 0 || status.stdout.trim()) throw new Error('Cannot review: the task workspace must be clean and committed before review.');
    },
  });
  return { exitCode: workflow.exitCode, report: localSelectionTrace(workflow), diagnostics: workflow.diagnostics };
}

/** Trace de sélection locale : la configuration native de l'utilisateur est conservée, aucun couple n'est imposé. */
function localSelectionTrace(workflow: PiRpcWorkflowResult): string {
  const sessions = `Pi RPC sessions: implementer ${workflow.implementerSessionId} (persistent across ${workflow.reviews.length} review cycle${workflow.reviews.length === 1 ? '' : 's'}); `
    + `reviewer sessions ${workflow.reviews.map(review => `${review.sessionId} (cycle ${review.cycle}: ${review.verdict})`).join(', ') || 'none'}.`;
  return [sessions, `Durable workflow evidence: sessions ${workflow.evidence.sessionsPath}; reviews ${workflow.evidence.reviewsPath}; events ${workflow.evidence.eventsPath}.`, workflow.report]
    .filter(Boolean).join('\n\n');
}

/** Découverte de l'extension officielle subagent pour Pi local : emplacements d'auto-découverte de Pi puis package npm global. */
async function discoverLocalSubagentExtension(request: LocalAgentRunRequest): Promise<{ path: string; explicit: boolean } | undefined> {
  const candidates: Array<{ path: string; explicit: boolean }> = [
    { path: path.join(homedir(), '.pi', 'agent', 'extensions', 'subagent', 'index.ts'), explicit: false },
    { path: path.join(request.workspacePath, '.pi', 'extensions', 'subagent', 'index.ts'), explicit: false },
  ];
  for (const candidate of candidates) {
    if (await readable(candidate.path) && await readable(path.join(path.dirname(candidate.path), 'agents.ts'))) return candidate;
  }
  const npmRoot = await request.logged({ command: 'npm', args: ['root', '-g'], cwd: request.workspacePath, stdin: 'ignore', signal: request.signal });
  if (npmRoot.exitCode === 0) {
    const directory = path.join(npmRoot.stdout.trim(), '@earendil-works', 'pi-coding-agent', 'examples', 'extensions', 'subagent');
    if (await readable(path.join(directory, 'index.ts')) && await readable(path.join(directory, 'agents.ts'))) return { path: path.join(directory, 'index.ts'), explicit: true };
  }
  return undefined;
}

async function readable(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

/** Canal RPC local : processus pi leader de son propre groupe POSIX, stdin piloté, arrêt ordonné avec escalade du groupe entier. */
function spawnLocalRpcChannel(request: LocalAgentRunRequest, args: string[], agentEnv: Record<string, string> | undefined, session: Parameters<PiRpcChannelFactory>[0]): PiRpcChannel {
  const startedAtIso = new Date().toISOString();
  const isolated = process.platform !== 'win32';
  const command = 'pi';
  const child = spawn(command, args, {
    cwd: request.workspacePath,
    env: agentEnv ? { ...process.env, ...agentEnv } : process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: isolated,
  });
  const pid = child.pid;
  let pending = '';
  let stderrTail = '';
  let exitCode: number | undefined;
  const exitWaiters: Array<(exit: { exitCode: number; stderrTail: string }) => void> = [];
  const observeExit = (code: number) => {
    if (exitCode !== undefined) return;
    exitCode = code;
    const exit = { exitCode: code, stderrTail };
    session.onExit(exit);
    for (const waiter of exitWaiters.splice(0)) waiter(exit);
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    request.stream('stdout', chunk);
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) session.onRecord(line);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    request.stream('stderr', chunk);
    session.onStderr(chunk);
    stderrTail = (stderrTail + chunk).slice(-4000);
  });
  child.once('error', error => { stderrTail = (stderrTail + String(error instanceof Error ? error.message : error)).slice(-4000); observeExit(1); });
  child.once('close', code => observeExit(code ?? 1));
  // Identités durables de la tentative : début incertain persisté avant le lancement, puis identité observée ; un échec laisse le début incertain durable pour la reprise.
  void (async () => {
    try {
      await request.onProcessStarting?.();
      if (!pid) return;
      const identity = await readLocalProcessIdentity(pid, [command, ...args].join(' '), startedAtIso);
      if (isolated) identity.processGroupId = pid;
      await request.onProcessSpawn?.(identity);
    } catch {
      // L'échec de persistance ne doit pas laisser un groupe d'agent non maîtrisé.
      if (pid) { signalAttemptGroup(pid, 'SIGTERM'); finishAttemptGroup(pid); }
    }
  })();
  const waitForExit = () => new Promise<{ exitCode: number; stderrTail: string }>(resolve => {
    if (exitCode !== undefined) resolve({ exitCode, stderrTail }); else exitWaiters.push(resolve);
  });
  let closing: Promise<{ exitCode: number; stderrTail: string }> | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  if (request.signal) {
    onAbort = () => {
      if (!pid) return;
      if (!isolated) { child.kill('SIGTERM'); return; }
      signalAttemptGroup(pid, 'SIGTERM');
      escalation = setTimeout(() => {
        void inspectLocalProcessGroup(pid).then(status => {
          if (status === 'alive') signalAttemptGroup(pid, 'SIGKILL');
        }).catch(() => { /* Une appartenance incertaine ne déclenche jamais un kill aveugle. */ });
      }, 1200);
      escalation.unref();
    };
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) onAbort();
  }
  const close = () => {
    closing ??= (async () => {
      if (exitCode === undefined) {
        try { child.stdin.end(); } catch { /* déjà fermé : la sortie du processus reste attendue */ }
        const deadline = async (ms: number) => (await Promise.race([waitForExit(), new Promise<'timeout'>(done => { const timer = setTimeout(() => done('timeout'), ms); timer.unref(); })]));
        if (await deadline(30_000) === 'timeout') {
          if (pid && isolated) signalAttemptGroup(pid, 'SIGTERM'); else child.kill('SIGTERM');
          if (await deadline(10_000) === 'timeout') {
            if (pid && isolated) signalAttemptGroup(pid, 'SIGKILL'); else child.kill('SIGKILL');
          }
        }
      }
      request.signal?.removeEventListener('abort', onAbort);
      if (escalation) clearTimeout(escalation);
      if (pid && isolated) await finishAttemptGroup(pid);
      return waitForExit();
    })();
    return closing;
  };
  return {
    writeLine: line => { try { if (!child.stdin.writableEnded) child.stdin.write(line + '\n'); } catch { /* stdin fermé : la mort du processus est observée par onExit */ } },
    close,
    get alive() { return exitCode === undefined; },
    describe: () => `pi ${args.map(value => /^[\w:./=-]+$/.test(value) ? value : JSON.stringify(value)).join(' ')} (pid ${pid ?? 'unknown'})`,
  };
}

/** Brief de la session reviewer locale pour ce passage : revue du diff complet du clone, délégation parallèle des deux axes, verdict explicite unique. */
function localReviewMessage(request: LocalAgentRunRequest, cycle: number, previous: PiReviewOutcome[]): string {
  const earlier = previous.map(review => `- Cycle ${review.cycle} returned ${review.verdict}${review.reason ? `: ${review.reason}` : ''}. Findings so far: ${review.findings}`).join('\n');
  return `Independent review, cycle ${cycle}, of the complete ticket diff in ${request.workspacePath} (${request.taskBaseCommit}...HEAD).\n` +
    `Delegate the Standards and Spec reviews now in one parallel subagent call ({tasks: [{agent, task}, {agent, task}]}); this is a read-only review, never edit or commit.\n` +
    (earlier ? `Control the findings already reported before writing anything new:\n${earlier}\n` : '') +
    `End with exactly one standalone verdict line SLOPIFY_REVIEW={"verdict":"approved"} or SLOPIFY_REVIEW={"verdict":"rejected","reason":"concrete reason"}.`;
}

/** Message de correction locale : les constats du reviewer partent comme NOUVEAU message à la même session implémenteur. */
function localCorrectionMessage(review: PiReviewOutcome): string {
  return `The independent review rejected the work (cycle ${review.cycle}${review.reason ? `: ${review.reason}` : ''}).\n` +
    `Correct every finding, revalidate, then commit before the next review.\n\n${review.findings}`;
}

/** Brief système de la session reviewer locale : revue en lecture seule, délégation parallèle Standards/Spec, verdict unique obligatoire. */
function localReviewerHarness(request: LocalAgentRunRequest): string {
  return `Independent local review harness for task ${request.taskId}. This is a read-only session that never shares the implementer conversation: judge only from the durable repository evidence, never from implementer declarations.\n` +
    `Delegated agents are named standards and spec; delegate both axes in one parallel subagent call ({tasks: [{agent, task}, {agent, task}]}), then verify their findings yourself.\n` +
    `End your final assistant message with exactly one standalone verdict line: SLOPIFY_REVIEW={"verdict":"approved"} or SLOPIFY_REVIEW={"verdict":"rejected","reason":"concrete remaining blocker"}. Never put this verdict line in intermediate messages or reviewer reports.`;
}

/** Brief d'un sous-agent reviewer local délégué (standards ou spec). */
function localReviewerRole(axis: 'standards' | 'spec', request: LocalAgentRunRequest): string {
  return `---\nname: ${axis}\ndescription: Independent ${axis} review\ntools: read, grep, find, ls, bash\n---\n` +
    `Perform only the delegated ${axis} review of the local workspace. Read-only inspection; do not edit or commit.\n` +
    `Read the complete frozen spec at ${path.join(request.contextPath, 'spec.md')}.\n` +
    `Read AGENTS.md and every applicable repository instruction and standards source, including inherited references.\n` +
    `Default diff: git diff ${request.taskBaseCommit}...HEAD; commits: git log ${request.taskBaseCommit}..HEAD --oneline.\n` +
    `Read the actual streamed execution traces at ${request.resultDirectory}/stdout.log and ${request.resultDirectory}/stderr.log, and observed commands at ${request.resultDirectory}/commands.jsonl.\n` +
    `The task prompt is ${JSON.stringify(request.prompt)}. Do not mistake an agent declaration for observed process evidence.\n` +
    `Report missing evidence as unverified, rather than inferring TDD or successful commands from commits or a final diff.\n` +
    `For Standards distinguish documented breaches from heuristic smells; repository standards override the baseline. For Spec quote missing, wrong or extra requirements.\n`;
}

function createLocalAgentRunner(): LocalAgentRunner {
  return async request => {
    if (request.agent === 'pi') return runPiLocal(request);
    const harness = await readFile(path.join(request.contextPath, 'harness.txt'), 'utf8');
    const codexArgs = ['exec', '--dangerously-bypass-approvals-and-sandbox', '--json'];
    if (request.model) codexArgs.push('--model', request.model);
    if (request.effort) codexArgs.push('-c', `model_reasoning_effort=${request.effort}`);
    codexArgs.push('-c', `developer_instructions=${JSON.stringify(harness)}`, request.prompt);
    const run = await spawnLocalAgent(request, 'codex', codexArgs);
    const diagnostics: TaskDiagnostic[] = [];
    const reports: string[] = [];
    for (const line of run.stdout.split(/\r?\n/)) {
      try { const event = JSON.parse(line) as { type?: string; message?: string; error?: { message?: string }; item?: { type?: string; text?: string } };
        if (event.type === 'error' || event.type === 'turn.failed') diagnostics.push({ code: 'codex_error', message: event.message ?? event.error?.message ?? line });
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') reports.push(event.item.text!);
      } catch { /* Non-JSON startup messages remain in the raw log. */ }
    }
    diagnostics.push(...agentOutcomeDiagnostics(reports.at(-1) ?? ''));
    return { exitCode: run.exitCode, report: reports.join('\n\n') || run.stdout || run.stderr, diagnostics };
  };
}
