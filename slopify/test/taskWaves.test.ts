import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { SubprocessExecutor } from '@acp-client/sandbox';
import { TaskBatchService, type BatchTask } from '../src/taskBatch.js';

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
  agent: (id: string, sandbox: string) => Promise<number>) {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-waves-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'host');
  execFileSync('git', ['init', '-q', repo]);
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
        const id = a.at(-1)!;
        launched.push(id);
        const exitCode = await agent(id, sandbox);
        const stdout = a.includes('pi')
          ? JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `${id} report` }] } })
          : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `${id} report` } });
        request.onOutput?.('stdout', stdout + '\n');
        return { exitCode, stdout: stdout + '\n', stderr: exitCode ? `${id} failed` : '' };
      }
      return ok();
    }
    throw new Error(`Unhandled sbx ${a.join(' ')}`);
  };
  const service = new TaskBatchService({ repositoryPath: repo, storePath: path.join(root, 'runs'), subprocessExecutor: execute });
  return { root, repo, head, dirty, batchFile, service, launched, removed, sandboxes };
}

test('a mixed wave overlaps, waits for every task and gives its descendant the combined published result', { timeout: 15000 }, async t => {
  const bothStarted = gate(); const finishSlow = gate(); const fastFinished = gate();
  const bases = new Map<string, string>();
  let running = 0; let maximum = 0;
  const f = await fixture(t, [task('slow', 'pi'), task('fast', 'codex'), task('combined', 'codex', ['slow', 'fast'])], async (id, sandbox) => {
    bases.set(id, git(sandbox, 'rev-parse', 'HEAD'));
    if (id === 'combined') {
      assert.equal(await readFile(path.join(sandbox, 'slow.txt'), 'utf8'), 'Pi result');
      assert.equal(await readFile(path.join(sandbox, 'fast.txt'), 'utf8'), 'Codex result');
      await writeFile(path.join(sandbox, 'combined.txt'), 'verified both');
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
  assert.equal(during.tasks[1].status, 'completed');
  assert.equal(git(f.repo, 'rev-parse', during.integrationBranch), f.head, 'no partial wave is integrated');
  assert.deepEqual([...f.launched].sort(), ['fast', 'slow']);
  finishSlow.release();
  const state = await result;
  assert.equal(state.status, 'succeeded');
  assert.equal(maximum, 2);
  assert.equal(bases.get('slow'), f.head); assert.equal(bases.get('fast'), f.head);
  assert.equal(bases.get('combined'), state.tasks[1].attempts[0].integratedCommit);
  assert.equal(git(f.repo, 'show', `${state.integrationBranch}:combined.txt`), 'verified both');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
  assert.equal(git(f.repo, 'status', '--porcelain=v1'), f.dirty);
  assert.equal(await readFile(path.join(f.repo, 'base.txt'), 'utf8'), 'dirty user content');
  assert.equal(f.sandboxes.size, 3); assert.equal(f.removed.length, 3);
  assert.deepEqual(state.tasks.map(v => v.status), ['succeeded', 'succeeded', 'succeeded']);
  for (const item of state.tasks) {
    assert.equal(item.attempts.length, 1);
    assert.ok(item.attempts[0].checkpoint?.commit);
    assert.match(await readFile(item.attempts[0].reportPath!, 'utf8'), /report/);
  }
  const messages = git(f.repo, 'log', '--format=%B', `${f.head}..${state.tasks[1].attempts[0].integratedCommit}`);
  assert.match(messages, /Slopify-Task: fast/);
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
  assert.deepEqual(state.tasks.map(v => v.status), ['failed', 'succeeded', 'blocked', 'blocked', 'succeeded']);
  assert.deepEqual(state.tasks[2].blockedBy, ['failed']);
  assert.deepEqual(state.tasks[3].blockedBy, ['blocked']);
  assert.deepEqual([...f.launched].sort(), ['failed', 'good', 'good-child']);
  assert.equal(state.tasks[0].attempts.length, 1);
  assert.equal(state.tasks[0].attempts[0].resourceState, 'retained');
  assert.equal(state.tasks[2].attempts.length, 0);
  assert.equal(git(f.repo, 'show', `${state.integrationBranch}:good-child.txt`), 'good work');
  assert.equal(git(f.repo, 'status', '--porcelain=v1'), f.dirty);
  assert.deepEqual((await f.service.status(state.runId)).tasks.map(v => v.status), state.tasks.map(v => v.status));
});

test('same wave tasks share the same base commit', { timeout: 15000 }, async t => {
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

test('cross-wave tasks start from the integrated commit of the previous wave', { timeout: 15000 }, async t => {
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
  assert.equal(bases.get('wave2-c'), state.tasks[1].attempts[0].integratedCommit);
});
