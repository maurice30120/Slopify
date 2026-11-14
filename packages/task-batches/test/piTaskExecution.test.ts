import { TaskBatchService } from './taskBatchTestService.js';
import assert from 'node:assert/strict';
import { configureRecreatedWorkers } from './recreatedWorkerFixture.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { SubprocessExecutor } from '@slopify/execution';

/**
 * Workflow Pi RPC natif au seam public du service de lots : le faux sbx injecté
 * traite les commandes classiques, et le transport RPC interactif est servi par un
 * faux serveur RPC réel (processus `sbx` factice sur le PATH, protocole JSONL
 * simulé) — sans Docker, sans réseau ni appel fournisseur. Le journal du faux
 * serveur prouve les identités de session : un processus implémenteur persistant
 * par tentative, un processus reviewer neuf par passage.
 */

/**
 * Faux serveur RPC Pi (protocole JSONL simulé sur stdio, sans Docker ni appel
 * fournisseur), écrit par la fixture dans le faux binaire `sbx` du PATH. Scénario
 * et journal passent par SLOPIFY_FAKE_RPC_SCENARIO / SLOPIFY_FAKE_RPC_LOG ; le rôle
 * vient du brief système passé à pi : harness.md = implémenteur, reviewer.md = reviewer.
 * Un processus fake = une session RPC ; le journal prouve les identités de session.
 */
const fakeRpcServerScript = `#!/usr/bin/env node
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
// La fixture simule le conteneur de tâche par un clone hôte <racine>/<sandbox> : le faux
// pi y écrit ses fichiers, comme le vrai pi écrit dans le workspace du conteneur.
const sandboxName = args.find((value, index) => index > 0 && value.startsWith('slopify-')) ?? '';
const workdir = (process.env.SLOPIFY_FAKE_RPC_ROOT && sandboxName)
  ? path.join(process.env.SLOPIFY_FAKE_RPC_ROOT, sandboxName)
  : option('-w') ?? process.cwd();
const role = path.basename(option('--append-system-prompt') ?? '') === 'reviewer.md' ? 'reviewer' : 'implementer';
const scenario = process.env.SLOPIFY_FAKE_RPC_SCENARIO
  ? JSON.parse(await readFile(process.env.SLOPIFY_FAKE_RPC_SCENARIO, 'utf8'))
  : {};
const logPath = process.env.SLOPIFY_FAKE_RPC_LOG;
const emit = record => process.stdout.write(JSON.stringify(record) + '\\n');
const log = async entry => { if (logPath) await appendFile(logPath, JSON.stringify({ pid: process.pid, role, sandboxName, ...entry }) + '\\n'); };
const readLog = async () => logPath
  ? (await readFile(logPath, 'utf8')).split('\\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return undefined; } }).filter(Boolean)
  : [];
const scenarioVerdicts = () => scenario.verdicts ?? ['SLOPIFY_REVIEW={"verdict":"approved"}'];
let implementerPrompts = 0;
let pendingPrompts = 0;
const stdin = createInterface({ input: process.stdin });
stdin.on('line', line => {
  let command;
  try { command = JSON.parse(line); } catch { return; }
  if (!command || command.type !== 'prompt') return;
  pendingPrompts += 1;
  void (async () => {
    try {
      await log({ kind: 'prompt', prompt: String(command.message ?? '').slice(0, 160) });
      emit({ id: command.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
      if (role === 'implementer') {
        implementerPrompts += 1;
        if (scenario.implementerCrash && !(await readLog()).some(entry => entry.kind === 'crash')) {
          await log({ kind: 'crash' });
          process.stderr.write('fake pi rpc crashed before settling\\n');
          process.exit(1);
        }
        if (scenario.providerError) {
          emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: scenario.providerError } });
        }
        const message = String(command.message ?? '');
        if (message.includes('code-review au diff complet')) {
          emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Final combined review report\\nSLOPIFY_RESULT={"status":"succeeded"}' }] } });
          emit({ type: 'agent_settled' });
          return;
        }
        const verdict = scenario.implementerVerdict ?? 'succeeded';
        const text = verdict === 'succeeded' ? 'Pi tests and review report\\nSLOPIFY_RESULT={"status":"succeeded"}'
          : verdict === 'failed' ? 'Blocked by final validation\\nSLOPIFY_RESULT={"status":"failed","reason":"final validation failed"}'
          : verdict === 'missing' ? 'Pi report without explicit verdict'
          : 'SLOPIFY_RESULT={"status":"maybe"}';
        const file = implementerPrompts === 1 ? 'implemented.txt' : 'corrected-' + (implementerPrompts - 1) + '.txt';
        await writeFile(path.join(workdir, file), 'implementation result');
        execFileSync('git', ['-C', workdir, 'add', file]);
        execFileSync('git', ['-C', workdir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fake implementation']);
        emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });
        emit({ type: 'agent_settled' });
        return;
      }
      const pass = (await readLog()).filter(entry => entry.role === 'reviewer' && entry.kind === 'prompt').length;
      const verdict = scenarioVerdicts()[Math.min(pass, scenarioVerdicts().length) - 1];
      const standards = scenario.reviewerStandardsFails
        ? { agent: 'standards', exitCode: 1, stderr: 'Mistral review request rejected', messages: [] }
        : { agent: 'standards', exitCode: 0, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Independent Standards findings cycle ' + pass }] }] };
      emit({ type: 'tool_execution_end', toolName: 'subagent', isError: false, result: { details: { mode: 'parallel', results: [
        standards,
        { agent: 'spec', exitCode: 0, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Independent Spec findings cycle ' + pass }] }] },
      ] } } });
      emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Independent review report cycle ' + pass + '\\n' + verdict }] } });
      emit({ type: 'agent_settled' });
    } finally { pendingPrompts -= 1; }
  })();
});
// Arrêt ordonné : fermeture du stdin = sortie au code zéro après le travail en vol, comme le contrat RPC de Pi.
stdin.on('close', () => {
  const finish = () => { if (pendingPrompts > 0) setTimeout(finish, 10); else process.exit(0); };
  finish();
});
`;

interface RpcLogEntry {
  pid: number;
  sandboxName: string;
  role: 'implementer' | 'reviewer';
  kind: 'prompt' | 'crash';
  prompt?: string;
}

interface FakeScenario {
  verdicts?: string[];
  implementerCrash?: boolean;
  providerError?: string;
  implementerVerdict?: 'succeeded' | 'failed' | 'missing' | 'invalid';
  reviewerStandardsFails?: boolean;
}

function git(repo: string, ...args: string[]) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim(); }

async function fixture(t: { after(fn: () => Promise<void>): void }, scenario: FakeScenario = {}, unavailable?: 'extension' | 'readonly') {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-pi-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'host');
  execFileSync('git', ['init', '-q', repo]);
  await configureRecreatedWorkers(repo);
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(repo, 'base.txt'), 'committed base'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const head = git(repo, 'rev-parse', 'HEAD');
  await writeFile(path.join(repo, 'base.txt'), 'dirty user content');
  const skills = path.join(root, 'official skills'); await mkdir(path.join(skills, 'code-review'), { recursive: true });
  await writeFile(path.join(skills, 'code-review', 'SKILL.md'), 'Official fixed smell baseline: Mysterious Name, Refused Bequest.');
  await writeFile(path.join(root, 'spec.md'), '# Approved full specification');
  // Distribution du bundle de workflows : Pi résout ses rôles ici, jamais depuis le store global.
  const distribution = path.join(root, 'distribution');
  for (const relative of ['skills/engineering/implement/SKILL.md', 'skills/engineering/tdd/SKILL.md', 'skills/engineering/code-review/SKILL.md']) {
    await mkdir(path.join(distribution, path.dirname(relative)), { recursive: true });
    await writeFile(path.join(distribution, relative), `Content of the ${path.basename(path.dirname(relative))} workflow skill.`);
  }
  await writeFile(path.join(distribution, 'inventory.json'), JSON.stringify({ roles: {
    implementer: { entry: 'skills/engineering/implement/SKILL.md', dependencies: [{ path: 'skills/engineering/tdd/SKILL.md' }] },
    reviewer: { entry: 'skills/engineering/code-review/SKILL.md', dependencies: [] },
  } }));
  const prompt = '$implement\nOriginal approved ticket';
  const batchFile = path.join(root, 'batch.json');
  await writeFile(batchFile, JSON.stringify({ specFile: 'spec.md', tasks: [{ id: 'work / unsafe', prompt, agent: 'pi', source: '01.md', dependsOn: [] }] }));
  // Faux serveur RPC : sbx factice sur le PATH, scénario et journal durables.
  const bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const scenarioFile = path.join(root, 'fake-rpc-scenario.json');
  const logFile = path.join(root, 'fake-rpc-log.jsonl');
  const serverScript = path.join(root, 'fake-sbx-rpc.mjs');
  await writeFile(scenarioFile, JSON.stringify(scenario));
  await writeFile(logFile, '');
  await writeFile(serverScript, fakeRpcServerScript, { mode: 0o600 });
  await writeFile(path.join(bin, 'sbx'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(serverScript)} "$@"\n`, { mode: 0o755 });
  const calls: string[][] = []; let sandbox = ''; let removed = false; const sandboxes = new Map<string, string>();
  const execute: SubprocessExecutor = async request => {
    if (request.command === 'git') { const r = spawnSync('git', request.args, { cwd: request.cwd, encoding: 'utf8' }); return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; }
    calls.push(request.args);
    const a = request.args;
    const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
    if (a[0] === 'version') return ok('sbx 0.47.0');
    if (a.includes('--help')) return ok('--clone --skills --json policy init');
    if (a[0] === 'policy') return ok('{"initialized":true}');
    if (a[0] === 'skills') return ok(JSON.stringify({ store: skills, skills: ['implement', 'tdd', 'code-review'] }));
    if (a[0] === 'kit') return ok('{}');
    if (a[0] === 'ls') return ok('[]');
    if (a[0] === 'create') {
      const name = a[a.indexOf('--name') + 1]; sandbox = path.join(root, name); execFileSync('git', ['clone', '-q', request.cwd, sandbox]);
      git(request.cwd, 'remote', 'add', `sandbox-${name}`, sandbox); sandboxes.set(name, sandbox); return ok();
    }
    if (a[0] === 'rm') { removed = true; return ok(); }
    if (a[0] === 'cp') {
      const source = a[1];
      if (source.endsWith('models.json')) { const provider = JSON.parse(await readFile(source, 'utf8')).providers['mistral']; assert.equal(provider.models[0].id, 'zai-glm-5-3'); assert.equal(provider.apiKey, '${MISTRAL_API_KEY}'); }
      if (source.endsWith('harness.md')) { const harness = await readFile(source, 'utf8'); assert.match(harness, /\{agent, task\}/); assert.match(harness, /\{tasks: \[\{agent, task\}\]\}/); assert.match(harness, /Invalid parameters\. Provide exactly one mode/); assert.match(harness, /fix the call shape/); assert.match(harness, /Do not trigger the independent review yourself/); }
      if (source.endsWith('reviewer.md')) { const reviewer = await readFile(source, 'utf8'); assert.match(reviewer, /read-only session that never shares the implementer conversation/); assert.match(reviewer, /Delegated agents are named standards and spec/); assert.match(reviewer, /SLOPIFY_REVIEW/); }
      if (source.endsWith('standards.md')) { const role = await readFile(source, 'utf8'); assert.match(role, /AGENTS\.md/); assert.match(role, /skills\/engineering\/code-review\/SKILL\.md/); assert.doesNotMatch(role, /Official fixed smell baseline/); assert.match(role, /stdout/); }
      if (source.endsWith('spec.md') && source.includes('agents')) assert.match(await readFile(source, 'utf8'), /full.*spec|complete.*spec/i);
      return ok();
    }
    if (a[0] === 'exec') {
      const index = a.indexOf('git'); if (index >= 0) { const name = a.find(v => sandboxes.has(v)); const cwd = name ? sandboxes.get(name)! : sandbox; const r = spawnSync('git', a.slice(index + 1), { cwd, encoding: 'utf8' }); return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; }
      if (a.includes('sh') && a.some(v => v.includes('findmnt'))) return unavailable === 'readonly' ? { exitCode: 1, stdout: '', stderr: 'Official skills are writable' } : ok();
      if (a.includes('sh') && a.some(v => v.includes('npm root -g'))) return unavailable === 'extension' ? { exitCode: 1, stdout: '', stderr: 'extension missing' } : ok('/opt/pi/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts\n');
      return ok();
    }
    throw new Error(`Unhandled sbx ${a.join(' ')}`);
  };
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  const previousScenario = process.env.SLOPIFY_FAKE_RPC_SCENARIO;
  const previousLog = process.env.SLOPIFY_FAKE_RPC_LOG;
  const previousRoot = process.env.SLOPIFY_FAKE_RPC_ROOT;
  process.env.SLOPIFY_FAKE_RPC_SCENARIO = scenarioFile;
  process.env.SLOPIFY_FAKE_RPC_LOG = logFile;
  process.env.SLOPIFY_FAKE_RPC_ROOT = root;
  t.after(async () => {
    process.env.PATH = previousPath;
    if (previousScenario === undefined) delete process.env.SLOPIFY_FAKE_RPC_SCENARIO; else process.env.SLOPIFY_FAKE_RPC_SCENARIO = previousScenario;
    if (previousLog === undefined) delete process.env.SLOPIFY_FAKE_RPC_LOG; else process.env.SLOPIFY_FAKE_RPC_LOG = previousLog;
    if (previousRoot === undefined) delete process.env.SLOPIFY_FAKE_RPC_ROOT; else process.env.SLOPIFY_FAKE_RPC_ROOT = previousRoot;
  });
  const readRpcLog = async (): Promise<RpcLogEntry[]> =>
    (await readFile(logFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as RpcLogEntry);
  const service = () => new TaskBatchService({ repositoryPath: repo, storePath: path.join(root, 'runs'), subprocessExecutor: execute, workflowResourcesRoot: distribution });
  return { root, repo, head, batchFile, prompt, calls, execute, distribution, sandboxes, scenarioFile, readRpcLog, service, get removed() { return removed; } };
}

test('a Pi RPC task corrects in one persistent implementer session, integrates durably and never touches the user workspace', { timeout: 30000 }, async t => {
  const f = await fixture(t, { verdicts: ['SLOPIFY_REVIEW={"verdict":"rejected","reason":"standards breach"}', 'SLOPIFY_REVIEW={"verdict":"approved"}'] });
  const state = await f.service().run(f.batchFile);
  assert.equal(state.status, 'succeeded');
  assert.equal(git(f.repo, 'show', `${state.integrationBranch}:implemented.txt`), 'implementation result');
  assert.equal(git(f.repo, 'show', `${state.integrationBranch}:corrected-1.txt`), 'implementation result');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
  assert.equal(await readFile(path.join(f.repo, 'base.txt'), 'utf8'), 'dirty user content');
  const attempt = state.tasks[0].attempts[0];
  assert.ok(attempt.checkpoint?.bundlePath);
  const report = await readFile(attempt.reportPath!, 'utf8');
  assert.match(report, /Pi tests and review report/);
  assert.match(report, /Independent Standards findings cycle 1/);
  assert.match(report, /Independent Spec findings cycle 2/);
  assert.match(report, /Pi selection: provider=mistral, model=zai-glm-5-3/);
  // Le transport RPC natif est le seul utilisé : aucune invocation one-shot --print.
  assert.equal(f.calls.some(a => a.includes('pi') && a.includes('--print')), false);
  // Journal du faux serveur RPC : un processus implémenteur persistant (2 messages), deux reviewers neufs (1 message chacun).
  const log = await f.readRpcLog();
  const implementer = log.filter(entry => entry.role === 'implementer' && entry.kind === 'prompt' && !entry.prompt?.includes('code-review au diff complet'));
  const reviewers = log.filter(entry => entry.role === 'reviewer' && entry.kind === 'prompt' && entry.sandboxName === attempt.resource?.sandboxName);
  assert.equal(new Set(implementer.map(entry => entry.pid)).size, 1, 'exactly one implementer process across the correction cycle');
  assert.equal(implementer.length, 2, 'initial ticket message then the correction message in the same session');
  assert.match(implementer[0].prompt!, /Original approved ticket/);
  assert.match(implementer[1].prompt!, /standards breach/);
  assert.equal(reviewers.length, 2);
  assert.equal(new Set(reviewers.map(entry => entry.pid)).size, 2, 'a fresh reviewer process per pass');
  assert.ok(reviewers.every(entry => /Independent review, cycle [12]/.test(entry.prompt!)));
  // La revue finale du lot passe aussi par une session RPC implémenteur dédiée.
  assert.ok(log.some(entry => entry.role === 'implementer' && entry.kind === 'prompt' && /code-review au diff complet/.test(entry.prompt!)));
  // Preuves durables du workflow : événements ordonnés à séquence dense, sessions reviewers distinctes.
  const evidence = path.join(path.dirname(attempt.stdoutPath!), 'pi-rpc');
  const events = (await readFile(path.join(evidence, 'workflow-events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1));
  assert.equal(events.at(-1)!.phase, 'workflow_succeeded');
  const sessions = (await readFile(path.join(evidence, 'sessions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const started = sessions.filter(record => record.event === 'started');
  assert.equal(started.filter(record => record.role === 'implementer').length, 1);
  assert.equal(started.filter(record => record.role === 'reviewer').length, 2);
  assert.equal(new Set(started.filter(record => record.role === 'reviewer').map(record => record.sessionId)).size, 2);
  const reviews = (await readFile(path.join(evidence, 'reviews.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(reviews.map(review => [review.cycle, review.verdict]), [[1, 'rejected'], [2, 'approved']]);
  assert.equal(f.removed, true);
  const create = f.calls.find(a => a[0] === 'create' && !a.includes('--help'))!;
  assert.ok(create.includes('readonly'));
  const distributionSkills = path.join(f.distribution, 'skills', 'engineering');
  assert.ok(create.some(arg => arg === `${distributionSkills}:ro`), 'the distributed workflow skills directory is the only skills mount');
  const kitArg = create.find(arg => arg.endsWith('pi-kit'))!;
  const kit = JSON.parse(await readFile(path.join(kitArg, 'spec.yaml'), 'utf8'));
  assert.equal(kit.sandbox.image, 'docker.io/sbx/pi-image:latest');
  assert.equal(kit.credentials[0].service, 'mistral');
  assert.equal(kit.credentials[0].apiKey.proxyManaged, true);
  assert.deepEqual(kit.permissions.network.allow, ['api.mistral.ai:443'], 'only required proxy provider receives a sandbox kit exception');
  assert.equal(kit.permissions.network.deny, undefined, 'global permissions remain available without a duplicate deny policy');
});

test('a Pi RPC session crash fails the attempt, and the explicit resume runs a fresh session without a duplicate process', { timeout: 30000 }, async t => {
  const f = await fixture(t, { implementerCrash: true, verdicts: ['SLOPIFY_REVIEW={"verdict":"approved"}'] });
  const first = await f.service().run(f.batchFile);
  assert.equal(first.status, 'failed');
  const attempt = first.tasks[0].attempts[0];
  assert.ok(attempt.diagnostics?.some(d => d.code === 'pi_rpc_session_crashed' && /exited with code 1/.test(d.message)));
  assert.equal(attempt.resourceState, 'retained');
  assert.equal(f.removed, false);
  // Aucun processus doublon : la tentative plantée n'a lancé qu'un seul implémenteur, jamais de reviewer.
  const log = await f.readRpcLog();
  const firstAttemptImplementer = log.filter(entry => entry.role === 'implementer' && entry.kind === 'prompt');
  assert.equal(new Set(firstAttemptImplementer.map(entry => entry.pid)).size, 1);
  assert.equal(log.some(entry => entry.role === 'reviewer'), false, 'no review runs for a crashed attempt');
  const firstEvents = (await readFile(path.join(path.dirname(attempt.stdoutPath!), 'pi-rpc', 'workflow-events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(firstEvents.some(event => event.phase === 'session_crashed'), true);
  assert.equal(firstEvents.at(-1)!.phase, 'workflow_failed');
  // Reprise explicite : nouvelle tentative, nouvelle session depuis l'état durable, sans doublon ni perte.
  const resumed = await f.service().resumeTask(first.runId, 'work / unsafe');
  assert.equal(resumed.tasks[0].status, 'succeeded');
  assert.equal(git(f.repo, 'show', `${resumed.integrationBranch}:implemented.txt`), 'implementation result');
  const secondAttempt = resumed.tasks[0].attempts[1];
  assert.notEqual(secondAttempt.attemptId, attempt.attemptId);
  const secondLog = await f.readRpcLog();
  const secondImplementer = secondLog.filter(entry => entry.role === 'implementer' && entry.kind === 'prompt' && entry.pid !== firstAttemptImplementer[0].pid);
  assert.equal(new Set(secondImplementer.map(entry => entry.pid)).size, 1, 'the resumed attempt runs exactly one fresh implementer process');
  assert.equal(secondLog.some(entry => entry.role === 'reviewer' && entry.kind === 'prompt'), true, 'the resumed attempt is independently reviewed');
  // Remontées agrégées sans duplication après reprise : chaque tentative a sa propre séquence dense, du premier événement.
  const secondEvents = (await readFile(path.join(path.dirname(secondAttempt.stdoutPath!), 'pi-rpc', 'workflow-events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(secondEvents[0].seq, 1);
  assert.deepEqual(secondEvents.map(event => event.seq), secondEvents.map((_, index) => index + 1));
  assert.equal(secondEvents.at(-1)!.phase, 'workflow_succeeded');
  assert.notEqual(secondEvents[0].sessionId, firstEvents[0].sessionId, 'the resumed session is a new RPC session');
});

for (const verdict of ['failed', 'missing', 'invalid'] as const) {
  test(`a Pi implementer verdict "${verdict}" fails the attempt without any review`, { timeout: 30000 }, async t => {
    const f = await fixture(t, { implementerVerdict: verdict });
    const state = await f.service().run(f.batchFile);
    assert.equal(state.status, 'failed');
    assert.equal(state.tasks[0].attempts[0].resourceState, 'retained');
    assert.equal(git(f.repo, 'rev-parse', state.integrationBranch), f.head);
    assert.equal(f.removed, false);
    const log = await f.readRpcLog();
    assert.equal(log.some(entry => entry.role === 'reviewer'), false, 'a self-reported or missing verdict is never reviewed');
  });
}

test('a Pi provider error observed in the RPC stream fails the attempt even when the process exits zero', { timeout: 30000 }, async t => {
  const f = await fixture(t, { providerError: 'HTTP 422: provider refused store' });
  const state = await f.service().run(f.batchFile);
  assert.equal(state.status, 'failed');
  const attempt = state.tasks[0].attempts[0];
  assert.ok(attempt.diagnostics?.some(d => d.code === 'pi_provider_error' && d.message.includes('HTTP 422')));
  assert.equal(f.removed, false);
});

test('a failed delegated Standards review stays observable and retains the sandbox even when the reviewer approves', { timeout: 30000 }, async t => {
  const f = await fixture(t, { reviewerStandardsFails: true, verdicts: ['SLOPIFY_REVIEW={"verdict":"approved"}'] });
  const state = await f.service().run(f.batchFile);
  assert.equal(state.status, 'failed');
  assert.equal(f.removed, false);
  const attempt = state.tasks[0].attempts[0];
  assert.ok(attempt.resource?.sandboxName);
  assert.ok(attempt.diagnostics?.some(d => d.code === 'pi_subagent_error' && /standards.*Mistral review request rejected/s.test(d.message)));
  assert.match(await readFile(attempt.reportPath!, 'utf8'), /Independent Spec findings cycle 1/);
});

test('Pi refuses a writable shared skill mount before starting any RPC session', { timeout: 30000 }, async t => {
  const f = await fixture(t, {}, 'readonly');
  const state = await f.service().run(f.batchFile);
  assert.equal(state.status, 'failed');
  assert.ok(state.tasks[0].attempts[0].diagnostics?.some(d => d.code === 'pi_capability' && /writable/.test(d.message)));
  assert.equal(f.calls.some(a => a.includes('pi') && a.includes('--print')), false);
  assert.equal((await f.readRpcLog()).length, 0, 'no RPC session is ever started without the readonly official skills');
  assert.equal(f.removed, false);
});

test('missing official Pi delegation capability fails before any RPC session', { timeout: 30000 }, async t => {
  const f = await fixture(t, {}, 'extension');
  const state = await f.service().run(f.batchFile);
  assert.equal(state.status, 'failed');
  assert.ok(state.tasks[0].attempts[0].diagnostics?.some(d => d.code === 'pi_subagent_unavailable'));
  assert.equal(f.calls.some(a => a.includes('pi') && a.includes('--print')), false);
  assert.equal((await f.readRpcLog()).length, 0, 'no RPC session is ever started without the delegation extension');
  assert.equal(f.removed, false);
});

test('a Pi-only batch runs from the distribution without a global official skills store', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const withoutStore: SubprocessExecutor = request => request.command === 'sbx' && request.args[0] === 'skills'
    ? Promise.resolve({ exitCode: 1, stdout: '', stderr: 'the global official skills store is not installed' })
    : f.execute(request);
  const service = new TaskBatchService({ repositoryPath: f.repo, storePath: path.join(f.root, 'runs'), subprocessExecutor: withoutStore, workflowResourcesRoot: f.distribution });
  const state = await service.run(f.batchFile);
  assert.equal(state.status, 'succeeded');
});
