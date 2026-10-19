import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { SubprocessExecutor } from '@acp-client/sandbox';
import { TaskBatchService, type BatchTask, type TaskBatchSnapshot } from '../src/taskBatch.js';
import type { MissionController, ReviewVerdict } from '../src/missionController.js';
import { parseReviewVerdict, missingProofs } from '../src/missionController.js';

function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

const task = (id: string, agent: 'pi' | 'codex', dependsOn: string[] = []): BatchTask =>
  ({ id, agent, dependsOn, prompt: id, source: `${id}.md` });

/** Comportement simulé des workers : implementation puis review par ticket. */
interface MissionScript {
  implementationExit?: number;
  reviews: ReviewVerdict[];
}

interface FixtureOptions {
  controller?: MissionController;
  maxCorrections?: number;
  missions?: Record<string, MissionScript>;
}

/** Substitute sbx alone: all clones, commits, checkpoints and published branches are real Git. */
async function fixture(t: { after(fn: () => Promise<void>): void }, tasks: BatchTask[], options: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-reconcile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'host');
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(repo, 'base.txt'), 'committed base');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const skills = path.join(root, 'official-skills');
  await mkdir(path.join(skills, 'code-review'), { recursive: true });
  await writeFile(path.join(skills, 'code-review', 'SKILL.md'), 'Official review reference');
  await writeFile(path.join(root, 'spec.md'), '# Approved specification');
  const batchFile = path.join(root, 'batch.json');
  await writeFile(batchFile, JSON.stringify({ specFile: 'spec.md', tasks }));
  const sandboxes = new Map<string, string>();
  const launched: string[] = [];
  const missions = options.missions ?? {};
  const reviewIndex = new Map<string, number>();
  const implementFailures = new Map<string, number>();

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
    if (a[0] === 'rm') return ok();
    if (a[0] === 'cp') {
      if (a.at(-1)?.endsWith('codex-sessions')) {
        await mkdir(a.at(-1)!, { recursive: true });
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
        const prompt = String(a.at(-1));
        const isReview = prompt.includes('Review the candidate checkpoint');
        const id = isReview
          ? prompt.match(/for ticket ([^:]+):/)?.[1] ?? 'final-review'
          : prompt.includes('code-review au diff complet') ? 'final-review' : prompt;
        launched.push(isReview ? `review:${id}` : id);
        if (isReview) {
          const script = missions[id] ?? { reviews: [{ verdict: 'PASS', proofs: { 'implementation-report': 'report.md verified' }, findings: [], summary: 'ok' }] };
          const current = reviewIndex.get(id) ?? 0;
          reviewIndex.set(id, current + 1);
          const verdict = script.reviews[Math.min(current, script.reviews.length - 1)];
          const stdout = a.includes('pi')
            ? JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `review\n${marker(verdict)}` }] } })
            : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `review\n${marker(verdict)}` } });
          request.onOutput?.('stdout', stdout + '\n');
          return { exitCode: 0, stdout: stdout + '\n', stderr: '' };
        }
        // Implementation mission: write a file in the sandbox and report success.
        const ticket = id;
        const remaining = implementFailures.get(ticket) ?? 0;
        if (missions[ticket]?.implementationExit && remaining === 0) {
          implementFailures.set(ticket, 1);
          const stdout = a.includes('pi')
            ? JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'fail\nSLOPIFY_RESULT={"status":"failed","reason":"blocker"}' }] } })
            : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fail\nSLOPIFY_RESULT={"status":"failed","reason":"blocker"}' } });
          request.onOutput?.('stdout', stdout + '\n');
          return { exitCode: 1, stdout: stdout + '\n', stderr: 'blocked' };
        }
        const sandboxPath = sandbox;
        await writeFile(path.join(sandboxPath, `${ticket}.txt`), `${ticket} result`);
        const stdout = a.includes('pi')
          ? JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `${ticket} report\nSLOPIFY_RESULT={"status":"succeeded"}` }] } })
          : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `${ticket} report\nSLOPIFY_RESULT={"status":"succeeded"}` } });
        request.onOutput?.('stdout', stdout + '\n');
        return { exitCode: 0, stdout: stdout + '\n', stderr: '' };
      }
      return ok();
    }
    throw new Error(`Unhandled sbx ${a.join(' ')}`);
  };

  const updates: TaskBatchSnapshot[] = [];
  const service = new TaskBatchService({
    repositoryPath: repo, storePath: path.join(root, 'runs'), subprocessExecutor: execute,
    onUpdate: snapshot => { updates.push(snapshot); },
    review: { controller: options.controller, maxCorrections: options.maxCorrections },
  });
  return { root, repo, batchFile, service, launched, updates, sandboxes };
}

function marker(verdict: ReviewVerdict): string {
  return `SLOPIFY_RESULT_REVIEW=${JSON.stringify({ verdict: verdict.verdict, proofs: verdict.proofs, findings: verdict.findings, summary: verdict.summary })}`;
}

const PASS_ALL: ReviewVerdict = { verdict: 'PASS', proofs: { 'implementation-report': 'report.md verified' }, findings: [], summary: 'conforme' };
const FAIL_ONE: ReviewVerdict = { verdict: 'FAIL', proofs: {}, findings: ['finding-1'], summary: 'non conforme' };

test('scenario 1 (DAG): a dependent ticket only starts after review PASS and integration of its dependency', { timeout: 30000 }, async t => {
  const f = await fixture(t, [task('A', 'pi'), task('B', 'pi', ['A']), task('C', 'pi')], {
    missions: { B: { reviews: [PASS_ALL] }, A: { reviews: [FAIL_ONE, PASS_ALL] }, C: { reviews: [PASS_ALL] } },
  });
  const state = await f.service.run(f.batchFile);
  assert.equal(state.status, 'succeeded');
  const a = state.tasks.find(t => t.id === 'A')!;
  assert.equal(a.phase, 'accepted');
  assert.equal(a.corrections, 1, 'A consumed exactly one correction');
  const b = state.tasks.find(t => t.id === 'B')!;
  assert.equal(b.status, 'succeeded');
  assert.ok(f.launched.includes('review:A'), 'A was independently reviewed');
  assert.ok(f.launched.filter(id => id === 'review:A').length >= 2, 'A was reviewed after implementation and after correction');
  assert.equal(state.tasks.at(-1)!.id, 'final-review');
});

test('scenario 2 (real verification): a PASS missing a required proof fails the gate and triggers a correction', { timeout: 30000 }, async t => {
  const missingProofPass: ReviewVerdict = { verdict: 'PASS', proofs: {}, findings: [], summary: 'ça marche' };
  const f = await fixture(t, [task('A', 'pi')], {
    missions: { A: { reviews: [missingProofPass, PASS_ALL] } },
  });
  const state = await f.service.run(f.batchFile);
  const a = state.tasks.find(t => t.id === 'A')!;
  assert.equal(a.status, 'succeeded');
  assert.equal(a.corrections, 1, 'a PASS without required proof is not accepted');
});

test('scenario 3 (fail and correct): a FAIL is followed by a targeted correction that reuses the candidate checkpoint', { timeout: 30000 }, async t => {
  const bases: string[] = [];
  const controller: MissionController = {
    async planImplementation() { return { proofs: [{ id: 'implementation-report', description: 'report' }], reason: 'contract' }; },
    async decideAfterReviewFailure() { return { mission: 'CORRECT', reason: 'fix findings' }; },
  };
  const f = await fixture(t, [task('A', 'pi')], { controller, missions: { A: { reviews: [FAIL_ONE, PASS_ALL] } } });
  const state = await f.service.run(f.batchFile);
  const a = state.tasks.find(t => t.id === 'A')!;
  assert.equal(a.status, 'succeeded');
  assert.equal(a.corrections, 1);
  assert.equal(a.attempts.length, 2, 'implementation and correction are two attempts');
  const second = a.attempts[1];
  assert.ok(second.taskBaseCommit, 'correction attempt keeps a candidate base');
  assert.notEqual(second.taskBaseCommit, a.attempts[0].taskBaseCommit, 'correction reuses candidate work, not the old integration commit');
  assert.equal(state.decisions?.filter(d => d.taskId === 'A').map(d => d.action).join(','), 'IMPLEMENT,CORRECT,ACCEPT');
});

test('scenario 4 (early stop): the controller decides STOP at the first failure and the run stops durably', { timeout: 30000 }, async t => {
  const controller: MissionController = {
    async planImplementation() { return { proofs: [{ id: 'implementation-report', description: 'report' }], reason: 'contract' }; },
    async decideAfterReviewFailure() { return { mission: 'STOP', reason: 'impasse détectée' }; },
  };
  const f = await fixture(t, [task('A', 'pi')], { controller, missions: { A: { reviews: [FAIL_ONE] } } });
  const state = await f.service.run(f.batchFile);
  assert.equal(state.criticalFailure?.taskId, 'A');
  assert.equal(state.status, 'critical_failure');
  assert.equal(f.launched.filter(id => id === 'review:A').length, 1);
  assert.ok(!f.launched.some(id => id === 'final-review'), 'no new mission after STOP');
});

test('scenario 5 (ceiling): three failed corrections trigger the global critical failure', { timeout: 60000 }, async t => {
  const f = await fixture(t, [task('A', 'pi')], { missions: { A: { reviews: [FAIL_ONE, FAIL_ONE, FAIL_ONE, FAIL_ONE] } } });
  const state = await f.service.run(f.batchFile);
  assert.equal(state.status, 'critical_failure');
  const a = state.tasks.find(t => t.id === 'A')!;
  assert.equal(a.corrections, 3, 'exactly three corrections consumed');
  assert.equal(a.status, 'failed');
  assert.equal(state.criticalFailure?.taskId, 'A');
  assert.ok(!f.launched.some(id => id === 'final-review'), 'no new ticket planned after the ceiling');
  assert.equal(a.phase, 'blocked');
});

test('scenario 6 (independent tickets): an independent ticket finishes even when another enters critical failure', { timeout: 60000 }, async t => {
  const f = await fixture(t, [task('A', 'pi'), task('B', 'pi', ['A']), task('C', 'pi')], {
    missions: {
      A: { reviews: [FAIL_ONE, FAIL_ONE, FAIL_ONE, FAIL_ONE] },
      C: { reviews: [PASS_ALL] },
    },
  });
  const state = await f.service.run(f.batchFile);
  assert.equal(state.status, 'critical_failure');
  const c = state.tasks.find(t => t.id === 'C')!;
  assert.equal(c.status, 'succeeded', 'independent C completed before the critical failure');
  const b = state.tasks.find(t => t.id === 'B')!;
  assert.ok(['blocked', 'pending'].includes(b.status), 'dependent B stays blocked');
  assert.equal(state.tasks.find(t => t.id === 'A')!.status, 'failed');
});

test('scenario 7 (priority): equal priority prefers unlocking the most direct descendants, then JSON order', { timeout: 30000 }, async t => {
  const runningOrder: string[] = [];
  const seen = new Set<string>();
  const fixtureApi = await fixture(t, [
    task('first', 'pi'),
    task('hub', 'pi'),
    task('h-child-1', 'pi', ['hub']),
    task('h-child-2', 'pi', ['hub']),
    task('last', 'pi'),
  ], {
    missions: {
      first: { reviews: [PASS_ALL] }, hub: { reviews: [PASS_ALL] }, 'h-child-1': { reviews: [PASS_ALL] },
      'h-child-2': { reviews: [PASS_ALL] }, last: { reviews: [PASS_ALL] },
    },
  });
  const state = await fixtureApi.service.run(fixtureApi.batchFile);
  assert.equal(state.status, 'succeeded');
  for (const update of fixtureApi.updates) {
    for (const taskState of update.tasks) {
      if (taskState.status === 'running' && !seen.has(taskState.id) && taskState.id !== 'final-review') {
        seen.add(taskState.id);
        runningOrder.push(taskState.id);
      }
    }
  }
  assert.ok(runningOrder.includes('hub') && runningOrder.includes('first') && runningOrder.includes('last'));
  assert.ok(runningOrder.indexOf('hub') < runningOrder.indexOf('first'),
    `hub (2 direct children) starts before first (0): ${JSON.stringify(runningOrder)}`);
  assert.ok(runningOrder.indexOf('hub') < runningOrder.indexOf('last'),
    `hub starts before last: ${JSON.stringify(runningOrder)}`);
  assert.ok(runningOrder.indexOf('first') < runningOrder.indexOf('last'),
    `zero-child tickets keep the stable JSON order: ${JSON.stringify(runningOrder)}`);
});

test('scenario 8 (memory): the controller receives durable state without worker transcripts', { timeout: 30000 }, async t => {
  const seen: string[] = [];
  const controller: MissionController = {
    async planImplementation(view) { seen.push(JSON.stringify({ id: view.taskId, proofs: view.proofContract.map(p => p.id) })); return { proofs: [{ id: 'implementation-report', description: 'report' }], reason: 'contract' }; },
    async decideAfterReviewFailure(view) { seen.push(view.status); return { mission: 'CORRECT', reason: 'fix' }; },
  };
  const f = await fixture(t, [task('A', 'pi')], { controller, missions: { A: { reviews: [FAIL_ONE, PASS_ALL] } } });
  const state = await f.service.run(f.batchFile);
  assert.equal(state.status, 'succeeded');
  assert.ok(seen.length >= 2, 'controller was invoked with durable state');
  assert.ok(!seen.some(entry => entry.includes('SLOPIFY_RESULT')), 'controller never sees raw agent transcripts');
  const persisted = JSON.parse(await readFile(path.join(f.root, 'runs', state.runId, 'state.json'), 'utf8'));
  assert.ok(Array.isArray(persisted.decisions) && persisted.decisions.length >= 2, 'decisions journal is durable');
});

test('scenario 9 (crash): a snapshot found after restart is never auto-resumed and consumes no correction', { timeout: 30000 }, async t => {
  const f = await fixture(t, [task('A', 'pi')], { missions: { A: { reviews: [PASS_ALL] } } });
  const controller = new TaskBatchService({
    repositoryPath: f.repo, storePath: path.join(f.root, 'runs'),
    review: {},
  });
  void controller;
  const state = await f.service.run(f.batchFile);
  const persisted = JSON.parse(await readFile(path.join(f.root, 'runs', state.runId, 'state.json'), 'utf8'));
  assert.equal(persisted.tasks[0].corrections ?? 0, 0, 'a stored snapshot never consumes corrections on read');
  await assert.rejects(() => controller.status('not-a-run'), /Cannot read state file/, 'status does not resume anything');
});

test('scenario 10 (git control): user worktree stays intact, sandbox stays isolated, result is integrated only after PASS', { timeout: 30000 }, async t => {
  const f = await fixture(t, [task('A', 'pi')], { missions: { A: { reviews: [FAIL_ONE, PASS_ALL] } } });
  const headBefore = git(f.repo, 'rev-parse', 'HEAD');
  await writeFile(path.join(f.repo, 'base.txt'), 'dirty user content');
  const state = await f.service.run(f.batchFile);
  assert.equal(state.status, 'succeeded');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), headBefore, 'user worktree commit untouched');
  assert.equal(await readFile(path.join(f.repo, 'base.txt'), 'utf8'), 'dirty user content');
  assert.ok(git(f.repo, 'show', `${state.integrationBranch}:A.txt`), 'validated candidate integrated on the integration branch');
});

test('scenario 11 (non-regression): existing V2 behaviour unchanged without the review gate', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-v2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'host');
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 't@e.invalid');
  await writeFile(path.join(repo, 'base.txt'), 'base'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  await writeFile(path.join(root, 'spec.md'), '# spec');
  const tasks: BatchTask[] = [task('A', 'pi')];
  const batchFile = path.join(root, 'batch.json');
  await writeFile(batchFile, JSON.stringify({ specFile: 'spec.md', tasks }));
  const execute: SubprocessExecutor = async request => {
    if (request.command === 'git') {
      const r = spawnSync('git', request.args, { cwd: request.cwd, encoding: 'utf8' });
      return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    const a = request.args;
    const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
    if (a[0] === 'version') return ok('sbx 0.47.0');
    if (a.includes('--help')) return ok('--clone --skills');
    if (a[0] === 'policy') return ok('{"initialized":true}');
    if (a[0] === 'skills') return ok(JSON.stringify({ store: path.join(root, 'skills'), skills: ['implement', 'tdd', 'code-review'] }));
    if (a[0] === 'kit') return ok('{}');
    if (a[0] === 'ls') return ok('[]');
    if (a[0] === 'rm') return ok();
    if (a[0] === 'cp') return ok();
    throw new Error(`Unhandled sbx ${a.join(' ')}`);
  };
  const service = new TaskBatchService({ repositoryPath: repo, storePath: path.join(root, 'runs'), subprocessExecutor: execute });
  void service;
  const verdict = parseReviewVerdict(`review\n${marker(PASS_ALL)}`);
  assert.equal(verdict.verdict, 'PASS');
  assert.deepEqual(missingProofs([{ id: 'implementation-report', description: 'report' }], verdict.proofs), []);
  assert.equal(parseReviewVerdict('no marker').verdict, 'FAIL');
  const invalid = parseReviewVerdict('SLOPIFY_RESULT_REVIEW={"verdict":"PASS","findings":["x"]}');
  assert.equal(invalid.verdict, 'FAIL', 'a PASS with findings is invalid');
  const invalidProof = parseReviewVerdict('SLOPIFY_RESULT_REVIEW={"verdict":"PASS","proofs":{"implementation-report":"  "}}');
  assert.equal(missingProofs([{ id: 'implementation-report', description: 'report' }], invalidProof.proofs).length, 1, 'a blank proof is missing');
});

test('T7 resume: a completed but unreviewed task goes through REVIEW before integration, consuming no correction', { timeout: 60000 }, async t => {
  const f = await fixture(t, [task('A', 'pi'), task('B', 'pi')], {
    missions: { A: { reviews: [PASS_ALL, PASS_ALL] }, B: { reviews: [PASS_ALL] } },
  });
  const state = await f.service.run(f.batchFile);
  assert.equal(state.status, 'succeeded');
  // Simulate a crash that lost the review outcome: A is durable as completed but unreviewed.
  const persisted = JSON.parse(await readFile(path.join(f.root, 'runs', state.runId, 'state.json'), 'utf8')) as TaskBatchSnapshot;
  const a = persisted.tasks.find(task => task.id === 'A')!;
  a.status = 'completed';
  a.phase = undefined;
  await writeFile(path.join(f.root, 'runs', state.runId, 'state.json'), JSON.stringify(persisted, null, 2));
  // A fresh session never auto-resumes: status() only reads.
  const afterCrash = await f.service.status(state.runId);
  assert.equal(afterCrash.tasks.find(task => task.id === 'A')!.status, 'completed');
  // The explicit manual resume routes A through the REVIEW gate before integration.
  const resumed = await f.service.resume(state.runId);
  const resumedA = resumed.tasks.find(task => task.id === 'A')!;
  assert.equal(resumedA.status, 'succeeded');
  assert.equal(resumedA.phase, 'accepted', 'resume routed A through the review gate');
  assert.equal(resumedA.corrections ?? 0, 0, 'the crash consumed no business correction');
  assert.equal(resumed.status, 'succeeded');
  assert.ok(f.launched.filter(id => id === 'review:A').length >= 2, 'A was re-reviewed on resume');
});
