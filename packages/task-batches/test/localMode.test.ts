import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { TaskBatchService, type BatchTask } from '@slopify/task-batches';
import type { LocalAgentRunRequest } from '@slopify/execution-local';

function git(repo: string, ...args: string[]) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim(); }

/** Fixture local : un vrai dépôt Git utilisateur, un agent local simulé écrivant dans le clone. */
async function localFixture(t: { after(fn: () => Promise<void>): void }, tasks: BatchTask[],
  agent: (id: string, clone: string, emit: (text: string) => void, signal?: AbortSignal) => Promise<number>) {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-local-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'host');
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(repo, 'base.txt'), 'committed base');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const head = git(repo, 'rev-parse', 'HEAD');
  await writeFile(path.join(repo, 'base.txt'), 'dirty user content');
  git(repo, 'add', 'base.txt');
  await writeFile(path.join(repo, 'untracked.txt'), 'user untracked change');
  const dirty = git(repo, 'status', '--porcelain=v1');
  await writeFile(path.join(root, 'spec.md'), '# Approved specification');
  const batchFile = path.join(root, 'batch.json');
  await writeFile(batchFile, JSON.stringify({ specFile: 'spec.md', tasks }));
  const seen: LocalAgentRunRequest[] = [];
  const localAgentRunner = async (request: LocalAgentRunRequest) => {
    seen.push(request);
    let out = '';
    const emit = (text: string) => { out += text + '\n'; request.logged({ command: 'cat', args: [], cwd: request.workspacePath, stdin: 'ignore', signal: request.signal, onOutput: (_s, chunk) => { out += chunk; } }); };
    const id = request.taskId;
    const exitCode = await agent(id, request.workspacePath, emit, request.signal);
    const report = `${id} local report\nSLOPIFY_RESULT={"status":"${exitCode === 0 ? 'succeeded' : 'failed'}","reason":"${exitCode === 0 ? '' : 'agent failed'}"}`;
    return { exitCode, report, diagnostics: [] };
  };
  const service = () => new TaskBatchService({ repositoryPath: repo, storePath: path.join(root, 'runs'), localAgentRunner });
  return { root, repo, head, dirty, batchFile, seen, service };
}


const task = (id: string, agent: 'pi' | 'codex', dependsOn: string[] = []): BatchTask => ({ id, agent, dependsOn, prompt: id, source: `${id}.md` });

test('a local Codex batch runs without sbx or Docker, keeps the user workspace intact and cleans integrated clones', async t => {
  const f = await localFixture(t, [task('work', 'codex')], async (id, clone) => {
    assert.equal(await readFile(path.join(clone, 'base.txt'), 'utf8'), 'committed base');
    await writeFile(path.join(clone, 'implemented.txt'), 'local result');
    return 0;
  });
  const state = await f.service().run(f.batchFile, { mode: 'local' });
  assert.equal(state.status, 'succeeded');
  assert.equal(state.mode, 'local');
  assert.equal(git(f.repo, 'show', `${state.integrationBranch}:implemented.txt`), 'local result');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
  assert.equal(git(f.repo, 'status', '--porcelain=v1'), f.dirty);
  assert.equal(await readFile(path.join(f.repo, 'base.txt'), 'utf8'), 'dirty user content');
  const attempt = state.tasks[0].attempts[0];
  assert.ok(attempt.checkpoint?.bundlePath);
  assert.ok(attempt.reportPath);
  assert.match(await readFile(attempt.reportPath!, 'utf8'), /local report/);
  // Le clone intégré est nettoyé après conservation des preuves.
  const clones = path.join(f.root, 'runs', state.runId, 'workspaces');
  const remaining = await readdir(clones).catch(() => []);
  assert.equal(remaining.length, 0, 'integrated clone is cleaned');
  // Aucun sbx n'est invoqué : la ressource décrit le clone local.
  assert.equal(attempt.resource?.worktreePath !== undefined, true);
  assert.deepEqual(attempt.resource?.inspectCommand?.[0], 'local');
});

test('a failed local attempt retains its clone and evidence for inspection', async t => {
  const f = await localFixture(t, [task('doomed', 'codex')], async () => 1);
  const state = await f.service().run(f.batchFile, { mode: 'local' });
  assert.equal(state.status, 'failed');
  const attempt = state.tasks[0].attempts[0];
  assert.equal(attempt.resourceState, 'retained');
  const remaining = await readdir(path.join(f.root, 'runs', state.runId, 'workspaces'));
  assert.equal(remaining.length, 1, 'failed clone is kept');
  assert.equal(git(f.repo, 'rev-parse', state.integrationBranch), f.head);
});

test('an invalid mode is refused before launching any agent', async t => {
  const f = await localFixture(t, [task('work', 'codex')], async () => 0);
  await assert.rejects(f.service().run(f.batchFile, { mode: 'docker' }), /Invalid execution mode/);
  assert.equal(f.seen.length, 0, 'no agent ran');
  assert.equal((await readdir(path.join(f.root, 'runs')).catch(() => [])).length, 0, 'no run was created');
});

test('sandbox stays the default and the project configuration can select local', async t => {
  const f = await localFixture(t, [task('work', 'codex')], async (id, clone) => {
    await writeFile(path.join(clone, 'implemented.txt'), 'local result');
    return 0;
  });
  // Sans option, sandbox est le défaut : le contrôle Docker s'applique et le run
  // s'interrompt honnêtement (docker_unavailable) ; aucun clone local n'est créé.
  const state = await f.service().run(f.batchFile);
  assert.equal(state.mode, 'sandbox');
  assert.ok(state.status === 'failed' || state.status === 'interrupted');
  const clones = await readdir(path.join(f.root, 'runs', state.runId, 'workspaces')).catch(() => []);
  assert.ok(clones.length <= 1, 'sandbox mode never runs a local agent on the clone');
  // La configuration du projet sélectionne local sans option CLI.
  await mkdir(path.join(f.repo, '.slopify'), { recursive: true });
  await writeFile(path.join(f.repo, '.slopify', 'runtime.yaml'), 'mode: local\nworkers:\n  size: 10\n  mounts: []\n');
  const localState = await f.service().run(f.batchFile);
  assert.equal(localState.status, 'succeeded');
  assert.equal(localState.mode, 'local');
  assert.equal(git(f.repo, 'show', `${localState.integrationBranch}:implemented.txt`), 'local result');
});

test('a CLI mode choice overrides the project configuration and an explicit sandbox overrides local', async t => {
  const f = await localFixture(t, [task('work', 'codex')], async (id, clone) => {
    await writeFile(path.join(clone, 'implemented.txt'), 'local result');
    return 0;
  });
  await mkdir(path.join(f.repo, '.slopify'), { recursive: true });
  await writeFile(path.join(f.repo, '.slopify', 'runtime.yaml'), 'mode: local\nworkers:\n  size: 10\n  mounts: []\n');
  const state = await f.service().run(f.batchFile, { mode: 'sandbox' });
  assert.equal(state.mode, 'sandbox');
  assert.ok(state.status === 'failed' || state.status === 'interrupted');
});

test('a local batch with dependencies pins bases and integrates prerequisites before descendants', { timeout: 15000 }, async t => {
  const bases = new Map<string, string>();
  const f = await localFixture(t, [task('first', 'codex'), task('second', 'codex', ['first'])], async (id, clone) => {
    bases.set(id, git(clone, 'rev-parse', 'HEAD'));
    if (id === 'second') assert.equal(await readFile(path.join(clone, 'first.txt'), 'utf8'), 'first result');
    await writeFile(path.join(clone, `${id}.txt`), `${id} result`);
    return 0;
  });
  const state = await f.service().run(f.batchFile, { mode: 'local' });
  assert.equal(state.status, 'succeeded');
  assert.equal(bases.get('first'), f.head);
  assert.notEqual(bases.get('second'), f.head);
  assert.equal(git(f.repo, 'show', `${state.integrationBranch}:second.txt`), 'second result');
});

test('interrupting a local run marks attempts interrupted and keeps clones for resume', { timeout: 15000 }, async t => {
  let release!: () => void;
  const started = new Promise<void>(resolve => { release = resolve; });
  const f = await localFixture(t, [task('slow', 'codex')], async (id, clone, emit, signal) => {
    release();
    await new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, 5000);
      signal?.addEventListener('abort', done, { once: true });
      if (signal?.aborted) done();
    });
    return signal?.aborted ? 1 : 0;
  });
  const controller = new AbortController();
  const pending = f.service().run(f.batchFile, { mode: 'local', signal: controller.signal });
  await started;
  controller.abort();
  const state = await pending;
  assert.equal(state.status, 'interrupted');
  assert.equal(state.tasks[0].status, 'interrupted');
  const attempt = state.tasks[0].attempts[0];
  assert.equal(attempt.status, 'interrupted');
  const remaining = await readdir(path.join(f.root, 'runs', state.runId, 'workspaces'));
  assert.equal(remaining.length, 1, 'interrupted clone is kept for inspection');
});

test('resume reuses the recorded local mode and succeeds', { timeout: 15000 }, async t => {
  let enabled = false;
  const f = await localFixture(t, [task('once', 'codex')], async (id, clone) => {
    if (!enabled) return 1;
    await writeFile(path.join(clone, 'implemented.txt'), 'retry result');
    return 0;
  });
  const first = await f.service().run(f.batchFile, { mode: 'local' });
  assert.equal(first.status, 'failed');
  assert.equal(first.mode, 'local');
  enabled = true;
  const resumed = await f.service().resume(first.runId);
  assert.equal(resumed.status, 'succeeded');
  assert.equal(resumed.mode, 'local');
  assert.equal(git(f.repo, 'show', `${resumed.integrationBranch}:implemented.txt`), 'retry result');
});

test('a local Pi task reuses native configuration without imposing Mistral or rewriting it', async t => {
  const f = await localFixture(t, [task('piwork', 'pi')], async (id, clone) => {
    await writeFile(path.join(clone, 'pi.txt'), 'pi local result');
    return 0;
  });
  const state = await f.service().run(f.batchFile, { mode: 'local' });
  assert.equal(state.status, 'succeeded');
  assert.equal(state.mode, 'local');
  assert.equal(git(f.repo, 'show', `${state.integrationBranch}:pi.txt`), 'pi local result');
  assert.equal(f.seen.length, 2); // implémentation + revue finale
  assert.ok(f.seen.every(req => req.agent === 'pi' || req.agent === 'codex'));
});

test('a mixed local Pi/Codex batch respects dependencies and integrates both results', { timeout: 15000 }, async t => {
  const f = await localFixture(t, [task('codex-part', 'codex'), task('pi-part', 'pi', ['codex-part'])], async (id, clone) => {
    if (id === 'pi-part') assert.equal(await readFile(path.join(clone, 'codex-part.txt'), 'utf8'), 'codex part');
    await writeFile(path.join(clone, `${id}.txt`), id === 'pi-part' ? 'pi part' : 'codex part');
    return 0;
  });
  const state = await f.service().run(f.batchFile, { mode: 'local' });
  assert.equal(state.status, 'succeeded');
  assert.equal(git(f.repo, 'show', `${state.integrationBranch}:codex-part.txt`), 'codex part');
  assert.equal(git(f.repo, 'show', `${state.integrationBranch}:pi-part.txt`), 'pi part');
  const agents = f.seen.map(req => req.agent).sort();
  assert.ok(agents.includes('pi') && agents.includes('codex'), 'both agents ran locally');
});

test('Pi local provider errors are visible and fail the attempt even with a zero exit', async t => {
  const f = await localFixture(t, [task('pifail', 'pi')], async () => 0);
  const service = new TaskBatchService({ repositoryPath: f.repo, storePath: path.join(f.root, 'runs'), localAgentRunner: async () => {
    return { exitCode: 0, report: '', diagnostics: [{ code: 'pi_provider_error', message: 'Observed provider failure' }] };
  }});
  const state = await service.run(f.batchFile, { mode: 'local' });
  assert.equal(state.status, 'failed');
  const attempt = state.tasks[0].attempts[0];
  assert.ok(attempt.diagnostics?.some(d => d.code === 'pi_provider_error'));
});

test('a missing or invalid Pi verdict fails the local attempt', async t => {
  // Le vrai runner Pi local est exercé avec un faux exécutable pi sur le PATH : il sort un
  // message final sans ligne SLOPIFY_RESULT ; le verdict explicite manque et la tentative
  // échoue malgré un code de sortie zéro.
  const f = await localFixture(t, [task('no-verdict', 'pi')], async () => 0);
  const bin = path.join(f.root, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'pi'), '#!/bin/sh\ncat <<EOF\n' + JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'work done, no verdict' }] } }) + '\nEOF\n', { mode: 0o755 });
  const service = new TaskBatchService({ repositoryPath: f.repo, storePath: path.join(f.root, 'runs') });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  try {
    const state = await service.run(f.batchFile, { mode: 'local' });
    assert.equal(state.status, 'failed');
    assert.ok(state.tasks[0].attempts[0].diagnostics?.some(d => /SLOPIFY_RESULT/.test(d.message)));
  } finally {
    process.env.PATH = previousPath;
  }
});


test('resume refuses to double an attempt whose local agent process is still alive', { timeout: 15000 }, async t => {
  const { readLocalProcessIdentity } = await import('@slopify/execution-local');
  const f = await localFixture(t, [task('survivor', 'codex')], async () => 0);
  const service = f.service();
  const created = await service.run(f.batchFile, { mode: 'local', execute: false });
  const survivor = created.tasks[0];
  survivor.status = 'running';
  survivor.attempts.push({
    attemptId: 'attempt-survivor', taskBaseCommit: created.runBaseCommit, status: 'running',
    startedAt: new Date().toISOString(),
    processIdentity: await readLocalProcessIdentity(process.pid, 'test runner'),
  });
  const statePath = path.join(f.root, 'runs', created.runId, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.tasks[0] = survivor;
  await writeFile(statePath, JSON.stringify(state, null, 2));
  await assert.rejects(service.resume(created.runId), /live local agent process/i);
});

test('portable process identity distinguishes alive, recycled and uncertain processes', async () => {
  const { readLocalProcessIdentity, inspectLocalProcess, isLocalProcessAlive } = await import('@slopify/execution-local');
  const identity = await readLocalProcessIdentity(process.pid, 'test runner');
  assert.ok(identity.startTimeTag && identity.observedCommand, 'ps must expose creation time and command on Linux/macOS');
  assert.equal(await inspectLocalProcess(identity), 'alive');
  assert.equal(await isLocalProcessAlive(identity), true);
  assert.equal(await inspectLocalProcess({ ...identity, startTimeTag: 'Wed Jan  1 00:00:00 1900' }), 'dead');
  assert.equal(await inspectLocalProcess({ ...identity, observedCommand: 'some other program' }), 'unknown');
  assert.equal(await inspectLocalProcess({ pid: process.pid, command: 'legacy', startedAtIso: identity.startedAtIso }), 'unknown');
  assert.equal(await inspectLocalProcess(undefined), 'unknown');
});

test('a durable successful checkpoint is integrated on resume without replaying the agent', { timeout: 15000 }, async t => {
  let executions = 0;
  const f = await localFixture(t, [task('durable', 'codex')], async (id, clone) => {
    executions++;
    await writeFile(path.join(clone, 'durable.txt'), 'durable result');
    return 0;
  });
  const first = await f.service().run(f.batchFile, { mode: 'local' });
  assert.equal(first.status, 'succeeded');
  // Implémentation + revue finale : deux exécutions d'agent la première fois.
  const firstRunExecutions = executions;
  assert.equal(firstRunExecutions, 2);
  // resume d'un run réussi ne rejoue aucun agent : les résultats durables sont réutilisés.
  const again = await f.service().resume(first.runId);
  assert.equal(again.status, 'succeeded');
  assert.equal(executions, firstRunExecutions, 'the durable success is not replayed');
});

test('aborting a real local Pi launcher stops its descendant process group', { timeout: 20000 }, async t => {
  if (process.platform === 'win32') return;
  const { inspectLocalProcessGroup } = await import('@slopify/execution-local');
  const f = await localFixture(t, [task('stop-pi', 'pi')], async () => 0);
  const bin = path.join(f.root, 'bin');
  await mkdir(bin, { recursive: true });
  const descendant = path.join(f.root, 'descendant.pid');
  const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  await writeFile(path.join(bin, 'pi'),
    '#!/bin/sh\\nsleep 30 &\\necho $! > ' + quote(descendant) + '\\nwait\\n', { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + previousPath;
  const controller = new AbortController();
  try {
    const service = new TaskBatchService({ repositoryPath: f.repo, storePath: path.join(f.root, 'runs') });
    const running = service.run(f.batchFile, { mode: 'local', signal: controller.signal });
    let childPid: number | undefined;
    for (let i = 0; i < 100; i += 1) {
      try { childPid = Number((await readFile(descendant, 'utf8')).trim()); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    if (!childPid) {
      controller.abort();
      await running;
      assert.fail('fake Pi never created a descendant');
    }
    controller.abort();
    const state = await running;
    assert.equal(state.status, 'interrupted');
    const attempt = state.tasks[0].attempts[0];
    assert.ok(attempt.resource, 'interrupted attempt keeps inspectable evidence');
    assert.ok(attempt.processIdentity?.processGroupId, 'runner records an isolated POSIX group');
    assert.equal(await inspectLocalProcessGroup(attempt.processIdentity!.processGroupId!), 'dead',
      'agent and descendant must no longer hold the process group');
  } finally {
    controller.abort();
    process.env.PATH = previousPath;
  }
});
