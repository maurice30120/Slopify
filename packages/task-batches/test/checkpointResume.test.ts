import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { SubprocessExecutor } from '@slopify/execution';
import { TaskBatchService, TaskBatchExecutionError, type TaskBatchSnapshot } from '@slopify/task-batches';
import { formatTaskBatchReport } from '@slopify/task-batches';

const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

interface Fixture {
  root: string;
  repo: string;
  directory: string;
  integration: string;
  commit: string;
  bundlePath: string;
  reportPath: string;
  attemptDirectory: string;
  service: TaskBatchService;
  snapshot: TaskBatchSnapshot;
  save(snapshot?: TaskBatchSnapshot): Promise<void>;
  calls: string[][];
  execute: SubprocessExecutor;
  storePath: string;
}

async function fixture(t: { after(fn: () => Promise<void>): void }, mutate?: (f: Fixture) => Promise<void>): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-checkpoint-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'host');
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(repo, 'base.txt'), 'base'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  await writeFile(path.join(root, 'spec.md'), '# Spec');
  const batchFile = path.join(root, 'batch.json');
  await writeFile(batchFile, JSON.stringify({ specFile: 'spec.md', tasks: [{ id: 'work', agent: 'codex', dependsOn: [], source: 'work', prompt: 'work' }] }));
  const calls: string[][] = [];
  const execute: SubprocessExecutor = async request => {
    if (request.command === 'git') {
      const r = spawnSync('git', request.args, { cwd: request.cwd, encoding: 'utf8' });
      return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    calls.push(request.args);
    return { exitCode: 1, stdout: '', stderr: 'Docker deliberately unavailable' };
  };
  const storePath = path.join(root, 'runs');
  const service = new TaskBatchService({ repositoryPath: repo, storePath, subprocessExecutor: execute });
  const snapshot = await service.run(batchFile, { execute: false });
  delete snapshot.workerPoolConfig; delete snapshot.workers;
  const directory = path.join(storePath, snapshot.runId);
  const integration = path.join(directory, 'integration');
  execFileSync('git', ['clone', '-q', repo, integration]);
  git(integration, 'config', 'user.name', 'Test'); git(integration, 'config', 'user.email', 'test@example.invalid');
  git(integration, 'branch', snapshot.integrationBranch, snapshot.runBaseCommit);
  await writeFile(path.join(integration, 'result.txt'), 'checkpoint'); git(integration, 'add', '.'); git(integration, 'commit', '-qm', 'checkpoint');
  const commit = git(integration, 'rev-parse', 'HEAD');
  const attemptDirectory = path.join(directory, 'attempts', 'original');
  await mkdir(attemptDirectory, { recursive: true });
  const bundlePath = path.join(attemptDirectory, 'checkpoint.bundle');
  git(integration, 'bundle', 'create', bundlePath, 'HEAD');
  const reportPath = path.join(attemptDirectory, 'report.md'); await writeFile(reportPath, 'original evidence');
  snapshot.status = 'failed'; snapshot.integrationCommit = snapshot.runBaseCommit;
  snapshot.tasks[0].status = 'failed';
  snapshot.tasks[0].attempts = [{ attemptId: 'original', taskBaseCommit: snapshot.runBaseCommit, status: 'succeeded', exitCode: 0, checkpoint: { commit, bundlePath }, reportPath }];
  const save = (value: TaskBatchSnapshot = snapshot) => writeFile(path.join(directory, 'state.json'), JSON.stringify(value));
  const f: Fixture = { root, repo, directory, integration, commit, bundlePath, reportPath, attemptDirectory, service, snapshot, save, calls, execute, storePath };
  if (mutate) await mutate(f);
  await save();
  return f;
}

test('targeted resume integrates a durable successful checkpoint without running a new agent', async t => {
  const f = await fixture(t);
  const state = await f.service.resumeTask(f.snapshot.runId, 'work');
  assert.equal(state.tasks[0].status, 'succeeded');
  assert.equal(state.tasks[0].attempts.length, 1);
  assert.equal(state.tasks[0].attempts[0].checkpointIntegrity?.status, 'valid');
  assert.equal(git(f.repo, 'show', `${state.integrationBranch}:result.txt`), 'checkpoint');
  assert.deepEqual(f.calls, []);
});

/** Chaque corruption est validée après l'import de l'objet attendu, comme en reprise réelle. */
const corruptions: Array<[name: string, expected: 'invalid' | 'incomplete', mutate: (f: Fixture) => Promise<void>]> = [
  ['missing bundle', 'incomplete', async f => { await rm(f.bundlePath); }],
  ['header-only bundle', 'invalid', async f => {
    const bytes = await readFile(f.bundlePath);
    await writeFile(f.bundlePath, bytes.subarray(0, bytes.indexOf(Buffer.from('PACK'))));
  }],
  ['truncated pack', 'invalid', async f => {
    const bytes = await readFile(f.bundlePath);
    await writeFile(f.bundlePath, bytes.subarray(0, bytes.length - 64));
  }],
  ['corrupted pack checksum', 'invalid', async f => {
    const bytes = await readFile(f.bundlePath);
    bytes[bytes.length - 1] ^= 0xff;
    await writeFile(f.bundlePath, bytes);
  }],
  ['unadvertised checkpoint commit', 'invalid', async f => {
    await writeFile(path.join(f.integration, 'later.txt'), 'later'); git(f.integration, 'add', '.'); git(f.integration, 'commit', '-qm', 'later');
    git(f.integration, 'bundle', 'create', f.bundlePath, 'HEAD');
  }],
  ['foreign ancestry', 'invalid', async f => {
    const tree = git(f.integration, 'rev-parse', 'HEAD^{tree}');
    const orphan = git(f.integration, 'commit-tree', tree, '-m', 'orphan');
    git(f.integration, 'update-ref', 'refs/heads/foreign-checkpoint', orphan);
    git(f.integration, 'bundle', 'create', f.bundlePath, 'refs/heads/foreign-checkpoint');
    f.snapshot.tasks[0].attempts[0].checkpoint = { commit: orphan, bundlePath: f.bundlePath };
  }],
];

test('targeted resume rejects unusable checkpoints without rerunning or overwriting evidence', async t => {
  for (const [name, expected, mutate] of corruptions) {
    const f = await fixture(t, mutate);
    const bundleBefore = await readFile(f.bundlePath).catch(() => null);
    const reportBefore = await readFile(f.reportPath, 'utf8');
    await assert.rejects(f.service.resumeTask(f.snapshot.runId, 'work'), (error: unknown) => {
      assert.ok(error instanceof TaskBatchExecutionError, `${name}: the CLI must report the durable outcome`);
      assert.match(error.message, /checkpoint is (invalid|incomplete)/, name);
      assert.equal(error.snapshot.tasks[0].attempts[0].checkpointIntegrity?.status, expected, name);
      // Le rapport que la CLI imprime pour cette reprise refusée expose le contrôle d'intégrité (#111).
      assert.match(formatTaskBatchReport(error.snapshot),
        new RegExp(`Checkpoints: 0 valid \\(\\), (0 invalid \\(\\), )?1 ${expected} \\(work: `),
        `${name}: the report must expose the ${expected} checkpoint integrity outcome`);
      return true;
    }, name);
    const state = JSON.parse(await readFile(path.join(f.directory, 'state.json'), 'utf8')) as TaskBatchSnapshot;
    assert.equal(state.tasks[0].status, 'failed', name);
    assert.equal(state.tasks[0].attempts.length, 1, name);
    const integrity = state.tasks[0].attempts[0].checkpointIntegrity;
    assert.equal(integrity?.status, expected, `${name}: ${integrity?.reason}`);
    assert.ok(integrity?.reason, name);
    const bundleAfter = await readFile(f.bundlePath).catch(() => null);
    assert.ok(bundleBefore === null ? bundleAfter === null : bundleAfter?.equals(bundleBefore), `${name}: bundle bytes changed`);
    assert.equal(await readFile(f.reportPath, 'utf8'), reportBefore, name);
    assert.deepEqual(f.calls, [], name);
  }
});

/** Ajoute un descendant bloqué de la tâche « work » au snapshot durable. */
const blockDescendant = async (f: Fixture): Promise<void> => {
  f.snapshot.tasks.push({ id: 'child', prompt: 'child', dependsOn: ['work'], agent: 'codex',
    source: 'child', status: 'blocked', blockedBy: ['work'], attempts: [] });
};

test('batch resume rejects an unusable durable checkpoint without rerunning, overwriting or unblocking', async t => {
  for (const [name, expected, mutate] of corruptions) {
    const f = await fixture(t, async f => { await mutate(f); await blockDescendant(f); });
    const bundleBefore = await readFile(f.bundlePath).catch(() => null);
    const reportBefore = await readFile(f.reportPath, 'utf8');
    await assert.rejects(f.service.resume(f.snapshot.runId), (error: unknown) => {
      assert.ok(error instanceof TaskBatchExecutionError, `${name}: the CLI must report the durable outcome`);
      assert.match(error.message, /checkpoint is (invalid|incomplete)/, name);
      return true;
    }, name);
    const state = JSON.parse(await readFile(path.join(f.directory, 'state.json'), 'utf8')) as TaskBatchSnapshot;
    const work = state.tasks.find(task => task.id === 'work')!;
    const child = state.tasks.find(task => task.id === 'child')!;
    assert.equal(work.status, 'failed', name);
    assert.equal(work.attempts.length, 1, name);
    assert.equal(work.attempts[0].checkpointIntegrity?.status, expected, name);
    assert.equal(child.status, 'blocked', name);
    assert.deepEqual(child.blockedBy, ['work'], name);
    const bundleAfter = await readFile(f.bundlePath).catch(() => null);
    assert.ok(bundleBefore === null ? bundleAfter === null : bundleAfter?.equals(bundleBefore), `${name}: bundle bytes changed`);
    assert.equal(await readFile(f.reportPath, 'utf8'), reportBefore, name);
    assert.deepEqual(f.calls, [], name);
  }
});

test('batch resume rejects an unusable checkpoint of a completed but not yet integrated task', async t => {
  const f = await fixture(t, async f => {
    f.snapshot.tasks[0].status = 'completed';
    await corruptions[2][2](f);
  });
  const reportBefore = await readFile(f.reportPath, 'utf8');
  await assert.rejects(f.service.resume(f.snapshot.runId), (error: unknown) => {
    assert.ok(error instanceof TaskBatchExecutionError);
    assert.match(error.message, /checkpoint is invalid/);
    return true;
  });
  const state = JSON.parse(await readFile(path.join(f.directory, 'state.json'), 'utf8')) as TaskBatchSnapshot;
  assert.equal(state.tasks[0].status, 'failed');
  assert.equal(state.tasks[0].attempts.length, 1);
  assert.equal(state.tasks[0].attempts[0].checkpointIntegrity?.status, 'invalid');
  assert.equal(await readFile(f.reportPath, 'utf8'), reportBefore);
  assert.deepEqual(f.calls, []);
});

test('batch resume validates a durable checkpoint before reusing it without rerunning the task', async t => {
  const f = await fixture(t);
  const state = await f.service.resume(f.snapshot.runId);
  const work = state.tasks[0];
  assert.equal(work.status, 'succeeded');
  assert.equal(work.attempts.length, 1, 'a validated durable checkpoint is reused, never rerun');
  assert.equal(work.attempts[0].checkpointIntegrity?.status, 'valid');
  assert.equal(git(f.repo, 'show', `${state.integrationBranch}:result.txt`), 'checkpoint');
  assert.ok(!f.calls.some(args => args.includes('work')), 'no agent runs for the reused task');
});

test('targeted resume refuses inadmissible work whose prerequisite is not integrated', async t => {
  const f = await fixture(t, async f => {
    f.snapshot.tasks[0].dependsOn = ['prereq'];
    f.snapshot.tasks.unshift({ id: 'prereq', prompt: 'prereq', dependsOn: [], agent: 'codex',
      source: 'prereq', status: 'failed', attempts: [] });
  });
  await assert.rejects(f.service.resumeTask(f.snapshot.runId, 'work'), /cannot be resumed: dependencies prereq are not succeeded/);
  const state = JSON.parse(await readFile(path.join(f.directory, 'state.json'), 'utf8')) as TaskBatchSnapshot;
  const work = state.tasks.find(task => task.id === 'work')!;
  assert.equal(work.status, 'failed');
  assert.equal(work.attempts.length, 1, 'no new attempt is created for inadmissible work');
  assert.deepEqual(f.calls, []);
});


/** Exécuteur sbx minimal : la préparation du run réussit, l'exécution de la tâche échoue. */
function sbxPreparingExecutor(calls: string[][]): SubprocessExecutor {
  return async request => {
    if (request.command === 'git') {
      const r = spawnSync('git', request.args, { cwd: request.cwd, encoding: 'utf8' });
      return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    const a = request.args;
    if (a[0] === 'version') return { exitCode: 0, stdout: 'sbx 0.48.0', stderr: '' };
    if (a.includes('--help')) return { exitCode: 0, stdout: '--clone --skills --json policy init', stderr: '' };
    if (a[0] === 'skills') return {
      exitCode: 0, stdout: JSON.stringify({ store: '/official', skills: ['implement', 'tdd', 'code-review'] }), stderr: '',
    };
    if (a[0] === 'ls') return { exitCode: 0, stdout: '[]', stderr: '' };
    if (a[0] === 'policy') return { exitCode: 0, stdout: '{"initialized":true}', stderr: '' };
    calls.push(a);
    return { exitCode: 1, stdout: '', stderr: 'Docker deliberately unavailable' };
  };
}

test('targeted resume can explicitly discard an unusable checkpoint and keeps the previous evidence', async t => {
  const f = await fixture(t, async f => { await corruptions[2][2](f); });
  const bundleBefore = await readFile(f.bundlePath);
  const reportBefore = await readFile(f.reportPath, 'utf8');
  const calls: string[][] = [];
  const service = new TaskBatchService({ repositoryPath: f.repo, storePath: f.storePath, subprocessExecutor: sbxPreparingExecutor(calls) });
  const state = await service.resumeTask(f.snapshot.runId, 'work', { discardCheckpoint: true });
  const work = state.tasks[0];
  assert.equal(work.status, 'failed', 'the retry runs and fails on the deliberately unavailable executor');
  assert.equal(work.attempts.length, 2, 'the explicit discard creates a new identifiable attempt');
  const [original, retry] = work.attempts;
  assert.equal(original.attemptId, 'original');
  assert.equal(original.checkpointIntegrity?.status, 'invalid');
  assert.ok(original.checkpointDiscarded, 'the operator decision is recorded on the discarded attempt');
  assert.ok(original.checkpointDiscarded!.discardedAt);
  assert.notEqual(retry.attemptId, 'original');
  assert.ok(retry.startedAt, 'the retry actually started');
  assert.ok(!retry.checkpointDiscarded);
  assert.ok(calls.length > 0, 'a real new attempt was launched');
  assert.ok((await readFile(f.bundlePath)).equals(bundleBefore), 'the previous bundle is preserved byte for byte');
  assert.equal(await readFile(f.reportPath, 'utf8'), reportBefore, 'the previous report is preserved');
  const persisted = JSON.parse(await readFile(path.join(f.directory, 'state.json'), 'utf8')) as TaskBatchSnapshot;
  assert.ok(persisted.tasks[0].attempts[0].checkpointDiscarded, 'the discard decision is durable');
});

test('the fail-closed rejection now points to the explicit discard escape hatch', async t => {
  const f = await fixture(t, async f => { await corruptions[2][2](f); });
  await assert.rejects(f.service.resumeTask(f.snapshot.runId, 'work'), (error: unknown) => {
    assert.ok(error instanceof TaskBatchExecutionError);
    assert.match(error.message, /checkpoint is invalid/);
    assert.match(error.message, /--discard-checkpoint/);
    return true;
  });
  await assert.rejects(f.service.resume(f.snapshot.runId), (error: unknown) => {
    assert.ok(error instanceof TaskBatchExecutionError);
    assert.match(error.message, /--discard-checkpoint/);
    return true;
  });
});
