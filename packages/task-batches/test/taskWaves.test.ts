import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { configureRecreatedWorkers } from './recreatedWorkerFixture.js';
import type { SubprocessExecutor } from '@slopify/execution';
import { TaskBatchService, type BatchTask, type TaskBatchSnapshot, type TaskBatchServiceOptions } from '@slopify/task-batches';
import { taskBatchReport, formatTaskBatchReport } from '@slopify/task-batches';

function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const task = (id: string, agent: 'pi' | 'codex', dependsOn: string[] = []): BatchTask => ({
  id, agent, dependsOn, prompt: id, source: `${id}.md`,
});

/** Substitute sbx alone: all clones, commits, checkpoints and published branches are real Git. */
async function fixture(t: { after(fn: () => Promise<void>): void }, tasks: BatchTask[],
  agent: (id: string, sandbox: string, signal?: AbortSignal) => Promise<number>, options: Pick<TaskBatchServiceOptions, 'maxConcurrentTasks'> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-waves-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'host');
  execFileSync('git', ['init', '-q', repo]);
  await configureRecreatedWorkers(repo);
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(repo, 'base.txt'), 'committed base');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const head = git(repo, 'rev-parse', 'HEAD');
  await writeFile(path.join(repo, 'staged.txt'), 'user staged change');
  git(repo, 'add', 'staged.txt');
  await writeFile(path.join(repo, 'untracked.txt'), 'user untracked change');
  await writeFile(path.join(repo, 'base.txt'), 'dirty user content');
  const dirty = git(repo, 'status', '--porcelain=v1');
  const skills = path.join(root, 'official-skills');
  await mkdir(path.join(skills, 'code-review'), { recursive: true });
  await writeFile(path.join(skills, 'code-review', 'SKILL.md'), 'Official review reference');
  await writeFile(path.join(root, 'spec.md'), '# Approved specification');
  const batchFile = path.join(root, 'batch.json');
  await writeFile(batchFile, JSON.stringify({ specFile: 'spec.md', tasks }));
  const sandboxes = new Map<string, string>();
  const launched: string[] = [];
  const removed: string[] = [];
  const execute: SubprocessExecutor = async request => {
    if (request.command === 'git') {
      const r = spawnSync('git', request.args, { cwd: request.cwd, encoding: 'utf8' });
      return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    assert.equal(request.command, 'sbx');
    const a = request.args;
    const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
    if (a[0] === 'version') return ok('sbx 0.47.0');
    if (a.includes('--help')) return ok('--clone --skills --json policy init');
    if (a[0] === 'policy') return ok('{"initialized":true}');
    if (a[0] === 'skills') return ok(JSON.stringify({ store: skills, skills: ['implement', 'tdd', 'code-review'] }));
    if (a[0] === 'kit') return ok('{}');
    if (a[0] === 'ls') return ok('[]');
    if (a[0] === 'create') {
      const name = a[a.indexOf('--name') + 1];
      const sandbox = path.join(root, name);
      execFileSync('git', ['clone', '-q', request.cwd, sandbox]);
      git(request.cwd, 'remote', 'add', `sandbox-${name}`, sandbox);
      sandboxes.set(name, sandbox);
      return ok();
    }
    if (a[0] === 'rm') { removed.push(a.at(-1)!); return ok(); }
    if (a[0] === 'cp') {
      if (a.at(-1)?.endsWith('codex-sessions')) {
        await mkdir(a.at(-1)!);
        await writeFile(path.join(a.at(-1)!, 'native.jsonl'), '{"type":"response_item"}\n');
      }
      return ok();
    }
    if (a[0] === 'exec') {
      const name = a.find(v => sandboxes.has(v));
      const sandbox = name ? sandboxes.get(name)! : undefined;
      assert.ok(sandbox, 'execution uses its own created sandbox');
      const index = a.indexOf('git');
      if (index >= 0) {
        const r = spawnSync('git', a.slice(index + 1), { cwd: sandbox, encoding: 'utf8' });
        return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      }
      if (a.some(v => v.includes('npm root -g'))) return ok('/opt/pi/examples/extensions/subagent/index.ts\n');
      if (a.includes('sh') && a.some(v => v.includes('$HOME/.codex/sessions'))) return ok('/home/agent/.codex/sessions');
      if ((a.includes('codex') && a.includes('--json')) || (a.includes('pi') && a.includes('--print'))) {
        const id = String(a.at(-1)).includes('code-review au diff complet') ? 'final-review' : a.at(-1)!;
        launched.push(id);
        const exitCode = await agent(id, sandbox, request.signal);
        const stdout = a.includes('pi')
          ? JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `${id} report\nSLOPIFY_RESULT={"status":"succeeded"}` }] } })
          : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `${id} report\nSLOPIFY_RESULT={"status":"succeeded"}` } });
        request.onOutput?.('stdout', stdout + '\n');
        return { exitCode, stdout: stdout + '\n', stderr: exitCode ? `${id} failed` : '' };
      }
      return ok();
    }
    throw new Error(`Unhandled sbx ${a.join(' ')}`);
  };
  const updates: TaskBatchSnapshot[] = [];
  const service = new TaskBatchService({ repositoryPath: repo, storePath: path.join(root, 'runs'), subprocessExecutor: execute, ...options, onUpdate: snapshot => { updates.push(snapshot); } });
  return { root, repo, head, dirty, batchFile, service, execute, launched, removed, sandboxes, updates };
}

test('a completed checkpoint unlocks its descendant while an unrelated sibling keeps its pinned base', { timeout: 15000 }, async t => {
  const bothStarted = gate(); const finishSlow = gate(); const fastFinished = gate();
  const bases = new Map<string, string>();
  let running = 0; let maximum = 0;
  const f = await fixture(t, [task('slow', 'pi'), task('fast', 'codex'), task('combined', 'codex', ['fast'])], async (id, sandbox) => {
    bases.set(id, git(sandbox, 'rev-parse', 'HEAD'));
    if (id === 'combined') {
      assert.equal(await readFile(path.join(sandbox, 'fast.txt'), 'utf8'), 'Codex result');
      await writeFile(path.join(sandbox, 'combined.txt'), 'verified fast');
      return 0;
    }
    running++; maximum = Math.max(maximum, running);
    if (running === 2) bothStarted.release();
    await bothStarted.promise;
    if (id === 'slow') await finishSlow.promise;
    await writeFile(path.join(sandbox, `${id}.txt`), id === 'slow' ? 'Pi result' : 'Codex result');
    running--;
    if (id === 'fast') fastFinished.release();
    return 0;
  });
  t.after(() => { bothStarted.release(); finishSlow.release(); return Promise.resolve(); });
  const result = f.service.run(f.batchFile);
  // Fail promptly when no executions launch instead of hanging on an external gate.
  const first = await Promise.race([bothStarted.promise.then(() => 'started'), result.then(() => 'returned')]);
  assert.equal(first, 'started');
  await fastFinished.promise;
  const runId = (await readdir(path.join(f.root, 'runs')))[0];
  let during = await f.service.status(runId);
  while (during.tasks[1].status === 'running') {
    await new Promise(resolve => setTimeout(resolve, 5));
    during = await f.service.status(runId);
  }
  for (let tries = 0; !f.launched.includes('combined') && tries < 1000; tries++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(f.launched.includes('combined'), 'fast descendant starts before the slow sibling finishes');
  assert.equal(during.tasks[0].attempts[0].taskBaseCommit, f.head);
  finishSlow.release();
  const state = await result;
  assert.equal(state.status, 'succeeded');
  assert.equal(maximum, 2);
  assert.equal(bases.get('slow'), f.head); assert.equal(bases.get('fast'), f.head);
  assert.equal(bases.get('combined'), state.tasks[1].attempts[0].integratedCommit);
  assert.equal(state.tasks[0].attempts[0].taskBaseCommit, f.head);
  assert.equal(git(f.repo, 'show', `${state.integrationBranch}:combined.txt`), 'verified fast');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
  assert.equal(git(f.repo, 'status', '--porcelain=v1'), f.dirty);
  assert.equal(await readFile(path.join(f.repo, 'base.txt'), 'utf8'), 'dirty user content');
  assert.equal(f.sandboxes.size, 4); assert.equal(f.removed.length, 4);
  assert.deepEqual(state.tasks.map(v => v.status), ['succeeded', 'succeeded', 'succeeded', 'succeeded']);
  for (const item of state.tasks) {
    assert.equal(item.attempts.length, 1);
    assert.ok(item.attempts[0].checkpoint?.commit);
    assert.match(await readFile(item.attempts[0].reportPath!, 'utf8'), /report/);
  }
  const messages = git(f.repo, 'log', '--format=%B', `${f.head}..${state.integrationCommit}`);
  assert.match(messages, /Slopify-Task: slow/);
});

test('a failed task blocks only its descendants while an independent later wave still integrates', async t => {
  const f = await fixture(t, [task('failed', 'pi'), task('good', 'codex'),
    task('blocked', 'codex', ['failed']), task('blocked-again', 'pi', ['blocked']),
    task('good-child', 'pi', ['good'])], async (id, sandbox) => {
    if (id === 'failed') return 1;
    if (id === 'good-child') assert.equal(await readFile(path.join(sandbox, 'good.txt'), 'utf8'), 'good work');
    await writeFile(path.join(sandbox, `${id}.txt`), 'good work');
    return 0;
  });
  const state = await f.service.run(f.batchFile);
  assert.equal(state.status, 'failed');
  assert.deepEqual(state.tasks.map(v => v.status), ['failed', 'succeeded', 'blocked', 'blocked', 'succeeded', 'blocked']);
  assert.deepEqual(state.tasks[2].blockedBy, ['failed']);
  assert.deepEqual(state.tasks[3].blockedBy, ['blocked']);
  assert.deepEqual(state.tasks[5].blockedBy, ['failed', 'blocked', 'blocked-again']);
  assert.deepEqual([...f.launched].sort(), ['failed', 'good', 'good-child']);
  assert.equal(state.tasks[0].attempts.length, 1);
  assert.equal(state.tasks[0].attempts[0].resourceState, 'retained');
  assert.equal(state.tasks[2].attempts.length, 0);
  assert.equal(git(f.repo, 'show', `${state.integrationBranch}:good-child.txt`), 'good work');
  assert.equal(git(f.repo, 'status', '--porcelain=v1'), f.dirty);
  assert.deepEqual((await f.service.status(state.runId)).tasks.map(v => v.status), state.tasks.map(v => v.status));
});

test('tasks admitted together share the same pinned base commit', { timeout: 15000 }, async t => {
  const bases = new Map<string, string>();
  const f = await fixture(t, [task('a', 'pi'), task('b', 'codex'), task('c', 'pi')], async (id, sandbox) => {
    bases.set(id, git(sandbox, 'rev-parse', 'HEAD'));
    await writeFile(path.join(sandbox, `${id}.txt`), `${id} result`);
    return 0;
  });
  const state = await f.service.run(f.batchFile);
  assert.equal(state.status, 'succeeded');
  assert.equal(bases.get('a'), f.head);
  assert.equal(bases.get('b'), f.head);
  assert.equal(bases.get('c'), f.head);
  assert.equal(bases.get('a'), bases.get('b'));
  assert.equal(bases.get('b'), bases.get('c'));
});

test('final verification task depending on all implementation tasks fails and prevents global success', { timeout: 15000 }, async t => {
  const f = await fixture(t, [
    task('impl1', 'pi'),
    task('impl2', 'codex'),
    task('verify', 'pi', ['impl1', 'impl2']),
  ], async (id, sandbox) => {
    if (id === 'verify') return 1;
    await writeFile(path.join(sandbox, `${id}.txt`), `${id} result`);
    return 0;
  });
  const state = await f.service.run(f.batchFile);
  assert.equal(state.status, 'failed');
  assert.equal(state.tasks[0].status, 'succeeded');
  assert.equal(state.tasks[1].status, 'succeeded');
  assert.equal(state.tasks[2].status, 'failed');
  assert.equal(state.tasks[2].attempts.length, 1);
  assert.equal(state.tasks[0].attempts.length, 1);
  assert.equal(state.tasks[1].attempts.length, 1);
  assert.equal(state.tasks[3].status, 'blocked');
});

test('batch report exposes per-task status, commits, reports, blockers, and integration branch', { timeout: 15000 }, async t => {
  const f = await fixture(t, [
    task('a', 'pi'),
    task('b', 'codex'),
    task('c', 'pi', ['a']),
    task('d', 'codex', ['b']),
  ], async (id, sandbox) => {
    await writeFile(path.join(sandbox, `${id}.txt`), `${id} result`);
    return 0;
  });
  const state = await f.service.run(f.batchFile);
  assert.equal(state.status, 'succeeded');
  assert.ok(state.integrationBranch);
  assert.ok(state.integrationCommit);
  for (const task of state.tasks) {
    assert.ok(task.id);
    assert.ok(task.status);
    assert.ok(task.agent);
    assert.ok(task.prompt);
    assert.ok(task.source);
    assert.ok(Array.isArray(task.attempts));
    assert.ok(task.attempts.length >= 1);
    for (const attempt of task.attempts) {
      assert.ok(attempt.attemptId);
      assert.ok(attempt.taskBaseCommit);
      assert.ok(attempt.status);
      if (attempt.status === 'succeeded') assert.ok(attempt.integratedCommit);
    }
  }
  const statusResult = await f.service.status(state.runId);
  assert.equal(statusResult.runId, state.runId);
  assert.equal(statusResult.integrationBranch, state.integrationBranch);
  assert.equal(statusResult.tasks.length, state.tasks.length);
});

test('no implicit retry or agent change on failure', { timeout: 15000 }, async t => {
  const f = await fixture(t, [
    task('failing', 'pi'),
    task('dependent', 'codex', ['failing']),
  ], async (id, sandbox) => {
    if (id === 'failing') return 1;
    return 0;
  });
  const state = await f.service.run(f.batchFile);
  assert.equal(state.tasks[0].attempts.length, 1);
  assert.equal(state.tasks[0].status, 'failed');
  assert.equal(state.tasks[1].status, 'blocked');
  assert.equal(state.tasks[1].attempts.length, 0);
  assert.deepEqual(state.tasks[1].blockedBy, ['failing']);
  assert.equal(state.tasks[0].agent, 'pi');
  assert.equal(state.tasks[1].agent, 'codex');
});

test('a task with several prerequisites starts from their combined integrated commit', { timeout: 15000 }, async t => {
  const bases = new Map<string, string>();
  const f = await fixture(t, [
    task('wave1-a', 'pi'),
    task('wave1-b', 'codex'),
    task('wave2-c', 'pi', ['wave1-a', 'wave1-b']),
  ], async (id, sandbox) => {
    bases.set(id, git(sandbox, 'rev-parse', 'HEAD'));
    await writeFile(path.join(sandbox, `${id}.txt`), `${id} result`);
    return 0;
  });
  const state = await f.service.run(f.batchFile);
  assert.equal(state.status, 'succeeded');
  // Wave 1 tasks share the same base (runBaseCommit)
  assert.equal(bases.get('wave1-a'), f.head);
  assert.equal(bases.get('wave1-b'), f.head);
  // Wave 2 task starts from the integrated commit of wave 1
  assert.notEqual(bases.get('wave2-c'), f.head);
  const latestPrerequisite = state.tasks.find(v => v.id === 'wave2-c')!.attempts[0].taskBaseCommit;
  assert.equal(bases.get('wave2-c'), latestPrerequisite);
  for (const name of ['wave1-a', 'wave1-b']) {
    assert.equal(git(f.repo, 'show', `${latestPrerequisite}:${name}.txt`), `${name} result`);
  }
});

for (const resume of [false, true]) {
  test(`twelve ready mixed-agent tasks refill available capacity without waiting for the slow sibling${resume ? ' after explicit resume' : ''}`, { timeout: 30000 }, async t => {
    const tenStarted = gate(); const finishSlow = gate(); const laterStarted = gate();
    t.after(async () => { tenStarted.release(); finishSlow.release(); });
    const ids = Array.from({ length: 12 }, (_, index) => `task-${index}`);
    const bases = new Map<string, string>();
    let executing = !resume;
    let active = 0; let maximum = 0; let later = 0;
    const tasks = ids.map((id, index) => task(id, index % 2 ? 'codex' : 'pi', resume ? ['seed'] : []));
    if (resume) tasks.unshift(task('seed', 'codex'));
    const f = await fixture(t, tasks, async (id, sandbox) => {
      if (id === 'seed') { await writeFile(path.join(sandbox, 'seed.txt'), 'preserved'); return 0; }
      if (!executing) return 1;
      bases.set(id, git(sandbox, 'rev-parse', 'HEAD'));
      active++; maximum = Math.max(maximum, active);
      if (ids.indexOf(id) < 10) {
        if (active === 10) tenStarted.release();
        await tenStarted.promise;
        if (id === ids[0]) await finishSlow.promise;
      } else if (id !== 'final-review') {
        later++;
        if (later === 2) laterStarted.release();
      }
      await writeFile(path.join(sandbox, `${id}.txt`), id);
      active--;
      return 0;
    });
    let result: ReturnType<TaskBatchService['run']>;
    let firstBase = f.head;
    if (resume) {
      const failed = await f.service.run(f.batchFile);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.tasks[0].status, 'succeeded');
      firstBase = failed.integrationCommit!;
      f.launched.length = 0;
      executing = true;
      result = f.service.resume(failed.runId);
    } else result = f.service.run(f.batchFile);
    assert.equal(await Promise.race([tenStarted.promise.then(() => 'started'), result.then(() => 'returned')]), 'started');
    const startedLater = await Promise.race([laterStarted.promise.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2500))]);
    assert.equal(startedLater, true, 'both remaining tasks start while the first task is still active');
    assert.deepEqual(f.launched.filter(id => ids.includes(id)).sort(), [...ids].sort());
    const runId = (await readdir(path.join(f.root, 'runs')))[0];
    const during = await f.service.status(runId);
    assert.equal(during.tasks.find(v => v.id === ids[0])!.status, 'running');
    assert.ok(during.tasks.filter(task => task.status === 'running').length <= 10);
    finishSlow.release();
    const state = await result;
    assert.equal(state.status, 'succeeded');
    assert.equal(maximum, 10);
    assert.equal(f.updates[0].status, 'ready', 'host learns the run ID before tasks launch');
    assert.equal(f.updates[0].runId, state.runId);
    assert.ok(f.updates.every(update => update.tasks.filter(task => task.status === 'running').length <= 10));
    assert.ok(f.updates.some(update => update.tasks.some(task => task.status === 'completed')), 'host sees results awaiting integration');
    assert.equal(f.updates.at(-1)!.status, 'succeeded');
    const work = state.tasks.filter(task => ids.includes(task.id));
    const finalReview = state.tasks.at(-1)!;
    assert.equal(finalReview.id, 'final-review');
    assert.equal(finalReview.status, 'succeeded');
    assert.equal(finalReview.attempts.length, 1);
    for (const id of ids.slice(0, 10)) assert.equal(bases.get(id), firstBase);
    for (const item of work) {
      assert.equal(item.attempts.length, resume ? 2 : 1);
      const attempt = item.attempts.at(-1)!;
      assert.equal(attempt.taskBaseCommit, bases.get(item.id));
      assert.ok(attempt.startedAt);
      assert.ok(attempt.finishedAt);
      assert.equal(git(f.repo, 'show', `${state.integrationBranch}:${item.id}.txt`), item.id);
    }
    const admitted = f.updates.flatMap(update => update.tasks.filter(item => ids.includes(item.id) && item.status === 'running').map(item => item.id));
    assert.deepEqual([...new Set(admitted)], ids, 'admission follows JSON order');
    if (resume) assert.equal(state.tasks[0].attempts.length, 1, 'successful seed never re-executes');
    assert.equal(f.sandboxes.size, resume ? 26 : 13, 'each attempt has a distinct sandbox');
  });
}


test('configured capacity survives an explicit resume and admits the first ready task immediately', { timeout: 15000 }, async t => {
  const initialStarted = gate(); const finishSlow = gate(); const finishFast = gate(); const thirdStarted = gate();
  t.after(async () => { initialStarted.release(); finishSlow.release(); finishFast.release(); });
  let enabled = false; let active = 0; let maximum = 0;
  const f = await fixture(t, [task('slow', 'pi'), task('fast', 'codex'), task('third', 'pi')], async (id, sandbox) => {
    if (!enabled) return 1;
    active++; maximum = Math.max(maximum, active);
    if (id === 'slow' || id === 'fast') {
      if (active === 2) initialStarted.release();
      await initialStarted.promise;
      await (id === 'slow' ? finishSlow.promise : finishFast.promise);
    } else if (id === 'third') thirdStarted.release();
    await writeFile(path.join(sandbox, `${id}.txt`), id);
    active--;
    return 0;
  }, { maxConcurrentTasks: 2 });
  const failed = await f.service.run(f.batchFile);
  assert.equal(failed.maxConcurrentTasks, 2);
  enabled = true;
  // A newly constructed service defaults to ten; the saved lot keeps its configured capacity.
  const resumed = new TaskBatchService({ repositoryPath: f.repo, storePath: path.join(f.root, 'runs'), subprocessExecutor: f.execute, onUpdate: update => { f.updates.push(update); } });
  const result = resumed.resume(failed.runId);
  await initialStarted.promise;
  assert.equal(f.launched.filter(id => id === 'third').length, 1, 'third only ran in the failed execution so far');
  finishFast.release();
  assert.equal(await Promise.race([thirdStarted.promise.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2500))]), true);
  finishSlow.release();
  const state = await result;
  assert.equal(state.status, 'succeeded');
  assert.equal(maximum, 2);
  assert.equal((await resumed.status(state.runId)).maxConcurrentTasks, 2);
  assert.ok(f.updates.every(update => update.tasks.filter(item => item.status === 'running').length <= 2));
});


test('checkpoints ready together integrate serially in JSON order without rerunning their agents', { timeout: 15000 }, async t => {
  const f = await fixture(t, [task('first', 'pi'), task('second', 'codex')], async (id, sandbox) => {
    await writeFile(path.join(sandbox, `${id}.txt`), id);
    return 0;
  });
  const produced = await f.service.run(f.batchFile);
  // Fixture a recovered coordinator with both durable checkpoints waiting at the same scheduling turn.
  const integration = path.join(f.root, 'runs', produced.runId, 'integration');
  git(integration, 'update-ref', `refs/heads/${produced.integrationBranch}`, f.head);
  git(f.repo, 'update-ref', `refs/heads/${produced.integrationBranch}`, f.head);
  produced.integrationCommit = f.head;
  produced.status = 'failed';
  for (const item of produced.tasks.slice(0, 2)) {
    item.status = 'completed';
    delete item.attempts[0].integratedCommit;
  }
  produced.tasks[2].status = 'pending';
  produced.tasks[2].attempts = [];
  await writeFile(path.join(f.root, 'runs', produced.runId, 'state.json'), JSON.stringify(produced));
  f.launched.length = 0;
  const resumed = await f.service.resume(produced.runId);
  assert.equal(resumed.status, 'succeeded');
  assert.deepEqual(f.launched, ['final-review']);
  const [first, second] = resumed.tasks;
  assert.equal(first.attempts[0].integratedCommit, first.attempts[0].checkpoint!.commit);
  assert.equal(git(f.repo, 'rev-parse', `${second.attempts[0].integratedCommit}^1`), first.attempts[0].integratedCommit);
  assert.equal(git(f.repo, 'show', `${resumed.integrationBranch}:first.txt`), 'first');
  assert.equal(git(f.repo, 'show', `${resumed.integrationBranch}:second.txt`), 'second');
});


test('a common Docker outage stops admission and active sandboxes while preserving their evidence', { timeout: 15000 }, async t => {
  const bothStarted = gate();
  let active = 0;
  let canceled = false;
  const f = await fixture(t, [task('slow', 'codex'), task('fault', 'codex'), task('later', 'codex')], async (id, sandbox, signal) => {
    active++;
    if (active === 2) bothStarted.release();
    await bothStarted.promise;
    await writeFile(path.join(sandbox, `${id}.txt`), 'partial evidence');
    if (id === 'fault') return 0;
    await new Promise<void>(resolve => {
      if (signal?.aborted) { canceled = true; resolve(); }
      else signal?.addEventListener('abort', () => { canceled = true; resolve(); }, { once: true });
    });
    return 1;
  }, { maxConcurrentTasks: 2 });
  let failedControl = false;
  const stopped: string[] = [];
  const service = new TaskBatchService({ repositoryPath: f.repo, storePath: path.join(f.root, 'runs'), maxConcurrentTasks: 2,
    subprocessExecutor: async request => {
      if (request.command === 'sbx' && request.args[0] === 'cp') {
        failedControl = true;
        return { exitCode: 1, stdout: '', stderr: 'Docker control unavailable' };
      }
      if (request.command === 'sbx' && request.args[0] === 'ls' && failedControl) {
        assert.equal(request.signal?.aborted, false, 'health check is independent of task cancellation');
        return { exitCode: 1, stdout: '', stderr: 'Docker daemon unavailable' };
      }
      if (request.command === 'sbx' && request.args[0] === 'stop') {
        stopped.push(request.args.at(-1)!);
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return f.execute(request);
    } });
  const state = await service.run(f.batchFile);
  assert.equal(state.status, 'interrupted');
  const suspension = JSON.parse(JSON.stringify(state)).suspension;
  assert.equal(suspension.kind, 'docker_unavailable');
  assert.match(suspension.healthCheck.stderr, /daemon unavailable/);
  assert.equal(canceled, true);
  assert.deepEqual(f.launched.sort(), ['fault', 'slow']);
  assert.equal(state.tasks[2].attempts.length, 0);
  assert.ok(stopped.includes(state.tasks[0].attempts[0].resource!.sandboxName));
  assert.equal(state.tasks[0].attempts[0].resourceState, 'retained');
  assert.equal(f.removed.length, 0);
  assert.equal(await readFile(path.join(f.sandboxes.get(state.tasks[0].attempts[0].resource!.sandboxName)!, 'slow.txt'), 'utf8'), 'partial evidence');
  assert.match(await readFile(state.tasks[1].attempts[0].stderrPath!, 'utf8'), /Docker control unavailable/);
  assert.equal(git(f.repo, 'status', '--porcelain=v1'), f.dirty);
});


test('a failed shared startup preflight admits no task and persists one run suspension', async t => {
  const f = await fixture(t, [task('first', 'codex'), task('second', 'codex')], async () => 0);
  let versions = 0;
  const service = new TaskBatchService({ repositoryPath: f.repo, storePath: path.join(f.root, 'runs'),
    subprocessExecutor: async request => {
      if (request.command === 'sbx' && request.args[0] === 'version') {
        versions++;
        return { exitCode: 1, stdout: '', stderr: 'Docker startup unavailable' };
      }
      if (request.command === 'sbx' && request.args[0] === 'ls') return { exitCode: 1, stdout: '', stderr: 'Docker unavailable' };
      return f.execute(request);
    } });
  const state = await service.run(f.batchFile);
  assert.equal(state.status, 'interrupted');
  assert.equal(versions, 1);
  assert.ok(state.tasks.every(item => item.attempts.length === 0), 'preflight failure is a run failure, no task has been admitted');
  assert.equal((await service.status(state.runId)).suspension?.kind, 'docker_unavailable');
});


test('a healthy Docker probe keeps a control error local and independent work continues without retry', async t => {
  const f = await fixture(t, [task('fault', 'codex'), task('independent', 'codex')], async (id, sandbox) => {
    await writeFile(path.join(sandbox, `${id}.txt`), id);
    return 0;
  }, { maxConcurrentTasks: 1 });
  let failed = false;
  let probes = 0;
  let versions = 0;
  const service = new TaskBatchService({ repositoryPath: f.repo, storePath: path.join(f.root, 'runs'), maxConcurrentTasks: 1,
    subprocessExecutor: async request => {
      if (request.command === 'sbx' && request.args[0] === 'version') versions++;
      if (request.command === 'sbx' && request.args[0] === 'cp' && !failed) {
        failed = true;
        return { exitCode: 1, stdout: '', stderr: 'local evidence copy failure' };
      }
      if (request.command === 'sbx' && request.args[0] === 'ls' && failed) probes++;
      return f.execute(request);
    } });
  const state = await service.run(f.batchFile);
  assert.equal(state.status, 'failed');
  assert.equal(state.suspension, undefined);
  assert.equal(probes, 1);
  assert.equal(versions, 1, 'one Docker preflight serves all task attempts');
  assert.deepEqual(f.launched, ['fault', 'independent']);
  assert.equal(state.tasks[0].attempts.length, 1);
  assert.equal(state.tasks[0].attempts[0].resourceState, 'retained');
  assert.equal(state.tasks[1].status, 'succeeded');
});


test('targeted resume has its own shared preflight and retains both attempts on common outage', async t => {
  const f = await fixture(t, [task('retry', 'codex')], async () => 1);
  const initial = await f.service.run(f.batchFile);
  const previous = initial.tasks[0].attempts[0];
  const previousLog = await readFile(previous.stderrPath!, 'utf8');
  let failedControl = false;
  let versions = 0;
  const service = new TaskBatchService({ repositoryPath: f.repo, storePath: path.join(f.root, 'runs'),
    subprocessExecutor: async request => {
      if (request.command === 'sbx' && request.args[0] === 'version') versions++;
      if (request.command === 'sbx' && request.args[0] === 'cp') { failedControl = true; throw new Error('Docker transport lost'); }
      if (request.command === 'sbx' && request.args[0] === 'ls' && failedControl) throw new Error('Docker health transport lost');
      if (request.command === 'sbx' && request.args[0] === 'stop') return { exitCode: 1, stdout: '', stderr: 'daemon still down' };
      return f.execute(request);
    } });
  const resumed = await service.resumeTask(initial.runId, 'retry');
  assert.equal(resumed.status, 'interrupted');
  assert.equal(versions, 1);
  assert.equal(resumed.suspension?.kind, 'docker_unavailable');
  assert.match(resumed.suspension?.healthCheck.error ?? '', /health transport lost/);
  assert.match(resumed.suspension?.stops[0].error ?? '', /daemon still down/);
  assert.equal(resumed.tasks[0].attempts.length, 2);
  assert.notEqual(resumed.tasks[0].attempts[1].resource?.sandboxName, previous.resource?.sandboxName);
  assert.equal(resumed.tasks[0].attempts[0].resourceState, 'retained');
  assert.equal(await readFile(previous.stderrPath!, 'utf8'), previousLog);
});


test('an integration conflict drains an active sibling and preserves its unintegrated checkpoint until explicit resolution', { timeout: 15000 }, async t => {
  const firstIntegrated = gate(); const conflictSeen = gate(); const finishSlow = gate();
  t.after(async () => { firstIntegrated.release(); finishSlow.release(); });
  const f = await fixture(t, [task('first', 'codex'), task('second', 'codex'), task('slow', 'codex'), task('later', 'codex', ['second'])], async (id, sandbox) => {
    if (id === 'second') await firstIntegrated.promise;
    if (id === 'slow') await finishSlow.promise;
    await writeFile(path.join(sandbox, id === 'slow' ? 'slow.txt' : 'base.txt'), id);
    return 0;
  }, { maxConcurrentTasks: 3 });
  const service = new TaskBatchService({ repositoryPath: f.repo, storePath: path.join(f.root, 'runs'), maxConcurrentTasks: 3,
    subprocessExecutor: f.execute, onUpdate: state => {
      if (state.tasks[0].status === 'succeeded') firstIntegrated.release();
      if (state.conflict) conflictSeen.release();
    } });
  const running = service.run(f.batchFile);
  assert.equal(await Promise.race([conflictSeen.promise.then(() => 'conflict'), running.then(() => 'returned')]), 'conflict');
  finishSlow.release();
  const state = await running;
  assert.equal(state.status, 'conflicted');
  assert.equal(state.suspension, undefined);
  assert.equal(state.tasks[2].status, 'completed');
  assert.ok(state.tasks[2].attempts[0].checkpoint);
  assert.equal(state.tasks[2].attempts[0].integratedCommit, undefined);
  assert.equal(state.tasks[2].attempts[0].resourceState, 'retained');
  assert.equal(state.tasks[3].attempts.length, 0);
  assert.equal(git(f.repo, 'show', `${state.integrationBranch}:base.txt`), 'first');
  assert.throws(() => git(f.repo, 'show', `${state.integrationBranch}:slow.txt`));
  await assert.rejects(service.resume(state.runId), /unresolved conflict/);
  assert.equal((await service.status(state.runId)).tasks[2].attempts.length, 1);
});

test('targeted resume after a failure uses a healthy worker distinct from the retained sandbox and keeps prior evidence', async t => {
  let attempts = 0;
  const f = await fixture(t, [task('fault', 'codex')], async (id, sandbox) => {
    attempts += 1;
    if (attempts === 1) return 1;
    await writeFile(path.join(sandbox, 'retry.txt'), 'retried work');
    return 0;
  });
  const initial = await f.service.run(f.batchFile);
  assert.equal(initial.status, 'failed');
  const failed = initial.tasks[0].attempts[0];
  const previousReport = await readFile(failed.reportPath!, 'utf8');
  const previousLog = await readFile(failed.stderrPath!, 'utf8');
  assert.equal(failed.resourceState, 'retained');
  // Aucune relance automatique : une seule tentative tant que l'opérateur n'agit pas.
  assert.equal(initial.tasks[0].attempts.length, 1);
  const resumed = await f.service.resumeTask(initial.runId, 'fault');
  const retry = resumed.tasks[0].attempts[1];
  assert.equal(resumed.tasks[0].status, 'succeeded', 'success only comes from the new valid execution');
  assert.equal(resumed.tasks[0].attempts.length, 2);
  assert.notEqual(retry.attemptId, failed.attemptId);
  assert.notEqual(retry.resource?.workerId, failed.resource?.workerId, 'the retry runs on a healthy worker, not the retained one');
  assert.notEqual(retry.resource?.sandboxName, failed.resource?.sandboxName);
  assert.ok(f.sandboxes.has(failed.resource!.sandboxName), 'the failed sandbox stays available for inspection');
  assert.ok(!f.removed.includes(failed.resource!.sandboxName));
  assert.equal(await readFile(failed.reportPath!, 'utf8'), previousReport, 'previous attempt evidence is preserved');
  assert.equal(await readFile(failed.stderrPath!, 'utf8'), previousLog);
  assert.notEqual(retry.reportPath, failed.reportPath);
  assert.equal(git(f.repo, 'show', `${resumed.integrationBranch}:retry.txt`), 'retried work');
});

test('descendants of a failed task stay blocked until an explicit resume integrates the prerequisite', async t => {
  let fail = true;
  const f = await fixture(t, [task('parent', 'codex'), task('child', 'codex', ['parent'])], async (id, sandbox) => {
    if (id === 'parent' && fail) return 1;
    await writeFile(path.join(sandbox, `${id}.txt`), `${id} work`);
    return 0;
  });
  const initial = await f.service.run(f.batchFile);
  assert.equal(initial.status, 'failed');
  assert.equal(initial.tasks[0].attempts.length, 1, 'no automatic retry of the failed task');
  const child = initial.tasks.find(item => item.id === 'child')!;
  assert.equal(child.status, 'blocked');
  assert.deepEqual(child.blockedBy, ['parent']);
  assert.equal(child.attempts.length, 0);
  fail = false;
  const targeted = await f.service.resumeTask(initial.runId, 'parent');
  assert.equal(targeted.tasks[0].status, 'succeeded');
  assert.equal(targeted.tasks.find(item => item.id === 'child')!.status, 'blocked',
    'the descendant stays blocked until its prerequisite is integrated');
  assert.ok(!f.launched.includes('child'));
  const resumed = await f.service.resume(initial.runId);
  assert.equal(resumed.status, 'succeeded');
  const relaunchedChild = resumed.tasks.find(item => item.id === 'child')!;
  assert.equal(relaunchedChild.status, 'succeeded');
  assert.equal(relaunchedChild.attempts.length, 1);
  assert.equal(relaunchedChild.attempts[0].taskBaseCommit, targeted.integrationCommit,
    'the descendant starts from the integrated prerequisite, not the run base');
  assert.equal(git(f.repo, 'show', `${resumed.integrationBranch}:child.txt`), 'child work');
});

test('a batch records the worker lifecycle with occupancy, retention and replacements', { timeout: 15000 }, async t => {
  const firstRunning = gate(); const releaseFirst = gate();
  t.after(() => { releaseFirst.release(); return Promise.resolve(); });
  const f = await fixture(t, [task('first', 'codex'), task('broken', 'codex'), task('third', 'codex')], async (id, sandbox) => {
    if (id === 'first') { await writeFile(path.join(sandbox, 'first.txt'), 'ok'); firstRunning.release(); await releaseFirst.promise; return 0; }
    if (id === 'broken') return 1;
    await writeFile(path.join(sandbox, 'third.txt'), 'ok'); return 0;
  });
  await writeFile(path.join(f.repo, '.slopify', 'runtime.yaml'), 'workers:\n  size: 1\n  lifecycle: recreate\n  mounts: []\n');
  const running = f.service.run(f.batchFile);
  assert.equal(await Promise.race([firstRunning.promise.then(() => 'started'), running.then(() => 'returned')]), 'started');
  const runId = (await readdir(path.join(f.root, 'runs')))[0];
  const during = await f.service.status(runId);
  const activeAttempt = during.tasks[0].attempts[0];
  assert.ok(activeAttempt, 'the gated task has a durable attempt');
  const assigned = during.workers?.filter(worker => worker.status === 'assigned') ?? [];
  assert.equal(assigned.length, 1, 'the running task occupies exactly one worker');
  assert.equal(assigned[0].taskId, 'first');
  assert.equal(assigned[0].attemptId, activeAttempt.attemptId);
  const midReport = taskBatchReport(during);
  assert.equal(midReport.workerPool?.occupancy.assigned, 1);
  assert.equal(midReport.workerPool?.replacements, 0);
  assert.match(formatTaskBatchReport(during), /assigned to task first \(attempt /);
  releaseFirst.release();
  const state = await running;
  assert.equal(state.status, 'failed');
  const workers = state.workers ?? [];
  assert.equal(workers.length, 3, 'each attempt runs on its own recreate-lifecycle worker');
  assert.equal(workers[0].status, 'retired');
  assert.equal(workers[0].taskId, 'first');
  assert.equal(workers[0].attemptId, state.tasks[0].attempts[0].attemptId);
  assert.equal(workers[0].replacements, 0, 'planned recreate recycling is never counted as a replacement');
  assert.equal(workers[1].status, 'retained');
  assert.equal(workers[1].taskId, 'broken');
  assert.equal(workers[1].attemptId, state.tasks[1].attempts[0].attemptId);
  assert.equal(workers[1].replacements, 0, 'a retained worker only counts once a new worker restores its capacity');
  assert.equal(workers[2].taskId, 'third');
  assert.equal(workers[2].replacements, 1, 'the worker that restores the failed capacity counts exactly one real replacement');
  const report = taskBatchReport(state);
  assert.deepEqual(report.workerPool?.occupancy, { available: 0, assigned: 0, cleaning: 0, verifying: 0, retained: 1, retired: 2 });
  assert.equal(report.workerPool?.replacements, 1);
  const text = formatTaskBatchReport(state);
  assert.match(text, /1 replacement during this run/);
  assert.match(text, /retained for inspection, task broken \(attempt /);
  assert.ok(text.includes(`Worker: ${workers[1].workerId}`), 'the failed attempt names its worker');
  const firstWorktree = state.tasks[0].attempts[0].resource!.worktreePath!;
  const brokenWorktree = state.tasks[1].attempts[0].resource!.worktreePath!;
  assert.ok(firstWorktree.includes(state.tasks[0].attempts[0].attemptId));
  assert.ok(brokenWorktree.includes(state.tasks[1].attempts[0].attemptId));
  assert.notEqual(firstWorktree, brokenWorktree, 'worktrees stay identified per task, not per worker');
  assert.ok(text.includes(`Worktree: ${brokenWorktree}`));
  assert.ok(text.includes(`Checkpoint bundle: ${state.tasks[0].attempts[0].checkpoint!.bundlePath}`));
});
