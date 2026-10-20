import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { TaskBatchService, type BatchTask } from '../src/taskBatch.js';
import type { LocalAgentRunRequest } from '../src/localTaskExecutor.js';

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
    await new Promise<void>((resolve, reject) => {
      const done = () => resolve();
      signal?.addEventListener('abort', done, { once: true });
      setTimeout(done, 5000);
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
