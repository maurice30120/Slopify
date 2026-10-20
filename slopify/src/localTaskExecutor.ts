import { appendFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { createNodeSubprocessExecutor, type SubprocessExecutor } from '@acp-client/sandbox';
import type { TaskBatchDiagnostic } from './taskBatch.js';
import type { TaskExecutor, TaskExecutionRequest, TaskExecutionResult, TaskSandboxResource } from './taskExecution.js';
import { agentOutcomeDiagnostics } from './agentOutcome.js';

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
    this.runner = options.agentRunner ?? createLocalAgentRunner(this.executor);
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
    const diagnostics: TaskBatchDiagnostic[] = [];
    let resource: TaskSandboxResource | undefined;
    let checkpoint: TaskExecutionResult['checkpoint'];
    // Chaque tentative locale travaille dans le clone privé fourni par le moteur de lots
    // (workspaces/<attemptId>), démarré sur sa base épinglée ; le workspace utilisateur
    // n'est jamais touché.
    const clonePath = request.workspacePath;
    const contextPath = path.join(request.resultDirectory, 'context');
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
        'TDD interfaces in the ticket are approved. Follow one red/green behavior at a time, targeted validation, full suite, then commit. Independent per-ticket Standards/Spec reviews are not required; the batch performs one final combined review of the integration branch.',
        'Read all applicable AGENTS.md and repository standards before implementation.',
        'Actual live raw execution traces: ' + stdoutPath + ' and ' + stderrPath + '. Observed harness commands: ' + eventsPath + '. Keep them intact as evidence for the final combined review.',
        'Uncommitted user changes are excluded from this private checkout.',
        'End your final assistant message with exactly one standalone line: SLOPIFY_RESULT={"status":"succeeded"} or SLOPIFY_RESULT={"status":"failed","reason":"concrete remaining blocker"}.',
        'Report failed if final required validations fail or work is incomplete. Expected intermediate TDD red tests are not final failures. A process exit code of zero does not establish task success. Missing or invalid verdicts fail the task. Never put this marker in reviewer reports or intermediate messages.',
      ].join('\n');
      await writeFile(path.join(contextPath, 'spec.md'), await readFile(request.specFile, 'utf8'), { mode: 0o600 });
      await writeFile(path.join(contextPath, 'harness.txt'), harness, { mode: 0o600 });
      const run = await this.runner({ ...request, workspacePath: clonePath, logged, contextPath });
      diagnostics.push(...run.diagnostics);
      await writeFile(reportPath, run.report, { mode: 0o600 });
      if (run.exitCode !== 0 || diagnostics.some(d => d.code !== 'codex_evidence_unavailable')) {
        return { exitCode: run.exitCode || 1, stdoutPath, stderrPath, reportPath, resource, diagnostics };
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
      return { exitCode: 0, checkpoint, stdoutPath, stderrPath, reportPath, resource, diagnostics };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push({ code: request.signal?.aborted ? 'interrupted' : 'execution_failed', message });
      appendFileSync(stderrPath, message + '\n');
      await writeFile(reportPath, 'Execution failed: ' + message, { mode: 0o600 });
      return { exitCode: 1, checkpoint, stdoutPath, stderrPath, reportPath, resource, diagnostics };
    }
  }

  async close(): Promise<void> {}

  /** Nettoie un clone intégré avec succès ; les clones en échec restent inspectables. */
  async cleanup(resource: TaskSandboxResource): Promise<void> {
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

export async function nativeCodexSessionFailures(directory: string): Promise<TaskBatchDiagnostic[]> {
  const diagnostics: TaskBatchDiagnostic[] = [];
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

export interface LocalAgentRunRequest extends TaskExecutionRequest {
  workspacePath: string;
  logged: SubprocessExecutor;
  contextPath: string;
}

export interface LocalAgentRunResult {
  exitCode: number;
  report: string;
  diagnostics: TaskBatchDiagnostic[];
}

export type LocalAgentRunner = (request: LocalAgentRunRequest) => Promise<LocalAgentRunResult>;

function createLocalAgentRunner(executor: SubprocessExecutor): LocalAgentRunner {
  return async request => {
    if (request.agent === 'pi') {
      throw new Error('Pi local is not supported yet.');
    }
    const harness = await readFile(path.join(request.contextPath, 'harness.txt'), 'utf8');
    const codexArgs = ['exec', '--dangerously-bypass-approvals-and-sandbox', '--json'];
    if (request.model) codexArgs.push('--model', request.model);
    if (request.effort) codexArgs.push('-c', `model_reasoning_effort=${request.effort}`);
    codexArgs.push('-c', `developer_instructions=${JSON.stringify(harness)}`, request.prompt);
    const run = await request.logged({ command: 'codex', args: codexArgs, cwd: request.workspacePath, stdin: 'ignore', signal: request.signal });
    const diagnostics: TaskBatchDiagnostic[] = [];
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
