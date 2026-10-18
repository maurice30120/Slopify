import assert from 'node:assert/strict';
import test from 'node:test';
import { taskBatchReport, formatTaskBatchReport, displayCommand } from '../src/taskBatchReport.js';
import type { BatchTaskState, TaskBatchSnapshot } from '../src/taskBatch.js';

function task(id: string, status: BatchTaskState['status'], dependsOn: string[] = []): BatchTaskState {
  return { id, status, dependsOn, agent: 'codex', prompt: 'unchanged prompt', source: `${id}.md`, attempts: [] };
}
function state(tasks: BatchTaskState[]): TaskBatchSnapshot {
  return { version: 1, runId: 'run', repositoryPath: '/repo with spaces', status: 'running',
    runBaseCommit: 'base', integrationCommit: 'integrated', integrationBranch: 'feature/run', createdAt: '', updatedAt: '2026-10-07T10:00:00Z',
    context: { specFile: '/store/run/context/spec.md', batchFile: '/store/run/context/batch.json', specText: 'spec' }, tasks,
    diagnostics: [{ code: 'host_changes_excluded', message: 'User changes excluded' }] };
}

test('host report distinguishes execution, integration, readiness and actual dependency blockers', () => {
  const failed = task('failed', 'failed');
  failed.attempts.push({ attemptId: 'attempt', taskBaseCommit: 'base', status: 'failed', exitCode: 0,
    diagnostics: [{ code: 'agent_result_failed', message: 'Required validation is still failing' }],
    stdoutPath: '/store/stdout.log', stderrPath: '/store/stderr.log', reportPath: '/store/report.md',
    resourceState: 'retained', resource: { sandboxName: 'sbx-task', inspectCommand: ['sbx', 'exec', 'sbx-task', 'sh'] } });
  const blocked = task('blocked', 'blocked', ['failed']); blocked.blockedBy = ['failed'];
  const snapshot = state([task('done', 'succeeded'), failed, blocked, task('active', 'running'),
    task('waiting', 'pending', ['active']), task('ready', 'pending'), task('finished', 'completed')]);
  const original = structuredClone(snapshot);
  const report = taskBatchReport(snapshot);
  assert.equal(report.progress.phase, 'executing');
  assert.equal(report.progress.total, 7);
  assert.deepEqual(report.progress.counts, { pending: 2, running: 1, completed: 1, succeeded: 1, failed: 1, interrupted: 0, blocked: 1, conflicted: 0 });
  assert.deepEqual(report.progress.activeTaskIds, ['active']);
  assert.deepEqual(report.progress.awaitingIntegrationTaskIds, ['finished']);
  assert.deepEqual(report.progress.readyTaskIds, ['ready']);
  assert.deepEqual(report.progress.waitingOn, [{ taskId: 'blocked', dependencyIds: ['failed'] }, { taskId: 'waiting', dependencyIds: ['active'] }]);
  assert.deepEqual(report.issues.find(issue => issue.code === 'agent_result_failed'), {
    code: 'agent_result_failed', message: 'Required validation is still failing', severity: 'error', taskId: 'failed', attemptId: 'attempt',
  });
  assert.equal(report.issues[0].severity, 'info');
  assert.deepEqual(report.nextActions[0].command, ['slopify', 'tasks', 'status', 'run', '--json', '--cwd', '/repo with spaces', '--store', '/store']);
  assert.ok(report.nextActions.some(action => action.command.join(' ') === 'sbx exec sbx-task sh'));
  const text = formatTaskBatchReport(snapshot);
  for (const part of ['1/7 integrated', '1 awaiting integration', 'Blocked by: failed', 'waiting waits for: active',
    'Required validation is still failing', 'Agent exit code: 0', '/store/report.md', '/store/stderr.log', 'sbx exec sbx-task sh', snapshot.updatedAt]) assert.ok(text.includes(part), part);
  assert.deepEqual(snapshot, original, 'reporting never changes durable state');
});

test('manual conflict status gives the resolution workspace and the precise validation command', () => {
  const snapshot = state([task('conflict', 'conflicted')]); snapshot.status = 'conflicted';
  snapshot.conflict = { taskId: 'conflict', attemptId: 'attempt', taskBaseCommit: 'base', currentCommit: 'current', incomingCommit: 'incoming', files: ['src/a.ts'], output: 'conflict' };
  snapshot.resolution = { resolutionId: 'resolution', conflictTaskId: 'conflict', conflictAttemptId: 'attempt', sandboxName: 'resolution-sandbox', sandboxPath: '/store/resolution', status: 'pending', createdAt: '' };
  const report = taskBatchReport(snapshot, '/chosen store');
  assert.equal(report.progress.phase, 'awaiting_resolution');
  assert.match(report.issues[0].message, /User changes/);
  assert.ok(report.issues.some(issue => issue.code === 'integration_conflict' && issue.message.includes('src/a.ts')));
  const validate = report.nextActions.find(action => action.command.includes('validate-resolution'));
  assert.deepEqual(validate?.command, ['slopify', 'tasks', 'validate-resolution', 'run', 'resolution', '--cwd', '/repo with spaces', '--store', '/chosen store']);
  assert.match(validate?.precondition ?? '', /commit/);
  assert.ok(!report.nextActions.some(action => action.command.includes('resume')));
  assert.match(formatTaskBatchReport(snapshot), /Resolution workspace: \/store\/resolution/);
});

test('completed checkpoints are shown as integrating rather than successful tasks', () => {
  const complete = task('complete', 'completed');
  complete.attempts.push({ attemptId: 'attempt', taskBaseCommit: 'base', status: 'succeeded', checkpoint: { commit: 'checkpoint', bundlePath: '/store/checkpoint.bundle' } });
  const snapshot = state([complete]);
  const report = taskBatchReport(snapshot);
  assert.match(formatTaskBatchReport(snapshot), /Checkpoint: checkpoint/);
  assert.equal(report.progress.phase, 'integrating');
  assert.equal(report.progress.counts.succeeded, 0);
});

test('failure and interruption offer explicit resume; recorded running tasks require liveness verification', () => {
  for (const status of ['failed', 'interrupted'] as const) {
    const snapshot = state([task('retry', status)]); snapshot.status = status;
    const report = taskBatchReport(snapshot);
    assert.ok(report.nextActions.some(action => action.command[2] === 'resume'));
    assert.ok(report.nextActions.some(action => action.command[2] === 'resume-task'));
    assert.ok(report.issues.some(issue => issue.code === `task_${status}`));
  }
  const report = taskBatchReport(state([task('stale', 'running')]));
  assert.match(report.nextActions.find(action => action.command.includes('resume-task'))?.precondition ?? '', /previous agent has stopped/);
});

test('successful runs only suggest inspecting the result and never inspecting a removed sandbox', () => {
  const done = task('done', 'succeeded');
  done.attempts.push({ attemptId: 'attempt', taskBaseCommit: 'base', status: 'succeeded', resourceState: 'removed',
    resource: { sandboxName: 'gone', inspectCommand: ['sbx', 'exec', 'gone', 'sh'] } });
  const snapshot = state([done]); snapshot.status = 'succeeded';
  const report = taskBatchReport(snapshot);
  assert.deepEqual(report.nextActions.map(action => action.command[0]), ['git']);
});

test('displayed commands quote shell metacharacters literally', () => {
  assert.equal(displayCommand(['slopify', '--cwd', '/repo with spaces', "a'b", '$(touch /tmp/unwanted)']),
    "slopify --cwd '/repo with spaces' 'a'\\''b' '$(touch /tmp/unwanted)'");
});

test('a recovered failure remains identifiable as history instead of a current retry problem', () => {
  const done = task('done', 'succeeded');
  done.attempts.push({ attemptId: 'attempt', taskBaseCommit: 'base', status: 'succeeded',
    diagnostics: [{ code: 'integration_failed', message: 'Previous publication failed' }] });
  const snapshot = state([done]); snapshot.status = 'succeeded';
  snapshot.diagnostics.push({ code: 'integration_failed', message: 'Previous run failed' });
  const report = taskBatchReport(snapshot);
  assert.ok(report.issues.filter(issue => issue.code === 'integration_failed').every(issue => issue.historical));
  assert.match(formatTaskBatchReport(snapshot), /error, historical/);
  assert.ok(!report.nextActions.some(action => action.command.includes('resume')));
});

test('the report exposes worker pool occupancy, replacement count and worker-to-attempt links', () => {
  const snapshot = state([task('active', 'running')]);
  snapshot.workerPoolConfig = { size: 6, mounts: [], lifecycle: 'reuse' };
  snapshot.workers = [
    { workerId: 'gen/1', sandboxName: 'slopify-worker-1', agent: 'codex', status: 'available', replacements: 0 },
    { workerId: 'gen/2', sandboxName: 'slopify-worker-2', agent: 'pi', status: 'assigned', taskId: 'active', attemptId: 'att-active', replacements: 1 },
    { workerId: 'gen/3', sandboxName: 'slopify-worker-3', agent: 'codex', status: 'cleaning', taskId: 'reset', attemptId: 'att-reset', replacements: 1 },
    { workerId: 'gen/4', sandboxName: 'slopify-worker-4', agent: 'codex', status: 'verifying', taskId: 'reset', attemptId: 'att-reset', replacements: 1 },
    { workerId: 'gen/5', sandboxName: 'slopify-worker-5', agent: 'pi', status: 'retained', taskId: 'failed', attemptId: 'att-failed', replacements: 2 },
    { workerId: 'gen/6', sandboxName: 'slopify-worker-6', agent: 'codex', status: 'retired', replacements: 2 },
  ];
  const original = structuredClone(snapshot);
  const report = taskBatchReport(snapshot);
  assert.deepEqual(report.workerPool, {
    size: 6, lifecycle: 'reuse',
    occupancy: { available: 1, assigned: 1, cleaning: 1, verifying: 1, retained: 1, retired: 1 },
    replacements: 2,
    workers: [
      { workerId: 'gen/1', agent: 'codex', status: 'available', replacements: 0 },
      { workerId: 'gen/2', agent: 'pi', status: 'assigned', taskId: 'active', attemptId: 'att-active', replacements: 1 },
      { workerId: 'gen/3', agent: 'codex', status: 'cleaning', taskId: 'reset', attemptId: 'att-reset', replacements: 1 },
      { workerId: 'gen/4', agent: 'codex', status: 'verifying', taskId: 'reset', attemptId: 'att-reset', replacements: 1 },
      { workerId: 'gen/5', agent: 'pi', status: 'retained', taskId: 'failed', attemptId: 'att-failed', replacements: 2 },
      { workerId: 'gen/6', agent: 'codex', status: 'retired', replacements: 2 },
    ],
  });
  const text = formatTaskBatchReport(snapshot);
  for (const part of [
    'Workers: 6 configured, lifecycle reuse; occupancy: 1 available, 1 assigned, 1 cleaning, 1 verifying, 1 retained, 1 retired; 2 replacements during this run',
    'gen/1 (codex): available',
    'gen/2 (pi): assigned to task active (attempt att-active)',
    'gen/3 (codex): cleaning task reset (attempt att-reset)',
    'gen/4 (codex): verifying reset of task reset (attempt att-reset)',
    'gen/5 (pi): retained for inspection, task failed (attempt att-failed)',
    'gen/6 (codex): retired',
  ]) assert.ok(text.includes(part), part);
  assert.deepEqual(snapshot, original, 'reporting never changes durable state');
});

test('legacy runs without a frozen worker pool stay readable without worker lines', () => {
  const snapshot = state([task('done', 'succeeded')]);
  const report = taskBatchReport(snapshot);
  assert.equal(report.workerPool, undefined);
  assert.ok(!formatTaskBatchReport(snapshot).includes('Workers:'));
});

test('task details name the worker and the per-attempt worktree behind each sandbox', () => {
  const first = task('first', 'succeeded');
  first.attempts.push({ attemptId: 'att-1', taskBaseCommit: 'base', status: 'succeeded', resourceState: 'removed',
    checkpoint: { commit: 'checkpoint', bundlePath: '/store/run/attempts/att-1/checkpoint.bundle' },
    resource: { sandboxName: 'slopify-worker-a', workerId: 'gen/1', worktreePath: '/store/run/workspaces/att-1',
      inspectCommand: ['sbx', 'exec', 'slopify-worker-a', 'sh'] } });
  const second = task('second', 'succeeded');
  second.attempts.push({ attemptId: 'att-2', taskBaseCommit: 'base', status: 'succeeded', resourceState: 'removed',
    checkpoint: { commit: 'checkpoint-2', bundlePath: '/store/run/attempts/att-2/checkpoint.bundle' },
    resource: { sandboxName: 'slopify-worker-a', workerId: 'gen/1', worktreePath: '/store/run/workspaces/att-2',
      inspectCommand: ['sbx', 'exec', 'slopify-worker-a', 'sh'] } });
  const unpooled = task('unpooled', 'failed');
  unpooled.attempts.push({ attemptId: 'att-3', taskBaseCommit: 'base', status: 'failed',
    resource: { sandboxName: 'sbx-task-3', inspectCommand: ['sbx', 'exec', 'sbx-task-3', 'sh'] } });
  const text = formatTaskBatchReport(state([first, second, unpooled]));
  for (const part of [
    'Worker: gen/1',
    'Worktree: /store/run/workspaces/att-1',
    'Worktree: /store/run/workspaces/att-2',
    '/store/run/attempts/att-1/checkpoint.bundle',
    '/store/run/attempts/att-2/checkpoint.bundle',
  ]) assert.ok(text.includes(part), part);
  assert.equal(text.split('Worker: gen/1').length - 1, 2, 'both attempts of the reused worker name it');
  assert.ok(!text.includes('Worktree: undefined'));
});


test('the reliability summary counts task failures and the attempt and retry history', () => {
  const flaky = task('flaky', 'succeeded');
  flaky.attempts.push({ attemptId: 'att-1', taskBaseCommit: 'base', status: 'failed', exitCode: 1 },
    { attemptId: 'att-2', taskBaseCommit: 'base', status: 'succeeded', exitCode: 0 });
  const broken = task('broken', 'failed');
  broken.attempts.push({ attemptId: 'att-3', taskBaseCommit: 'base', status: 'failed', exitCode: 2 });
  const stopped = task('stopped', 'interrupted');
  stopped.attempts.push({ attemptId: 'att-4', taskBaseCommit: 'base', status: 'interrupted' });
  const fresh = task('fresh', 'pending');
  const snapshot = state([flaky, broken, stopped, fresh]);
  const original = structuredClone(snapshot);
  const report = taskBatchReport(snapshot);
  assert.deepEqual(report.reliability.failedTaskIds, ['broken']);
  assert.deepEqual(report.reliability.interruptedTaskIds, ['stopped']);
  assert.deepEqual(report.reliability.attempts, { total: 4, retries: 1, retriedTaskIds: ['flaky'] });
  const text = formatTaskBatchReport(snapshot);
  assert.ok(text.includes('Reliability: 1 failed task (broken); 1 interrupted (stopped); 4 attempts, 1 retry (flaky)'),
    'the reliability line is rendered');
  assert.deepEqual(snapshot, original, 'reporting never changes durable state');
});


test('reliability summarises worker occupancy and points to the detailed worker lifecycle', () => {
  const active = task('active', 'running');
  active.attempts.push({ attemptId: 'att-active', taskBaseCommit: 'base', status: 'running' });
  const snapshot = state([active]);
  snapshot.workerPoolConfig = { size: 2, mounts: [], lifecycle: 'reuse' };
  snapshot.workers = [
    { workerId: 'gen/1', sandboxName: 'slopify-worker-1', agent: 'codex', status: 'available', replacements: 0 },
    { workerId: 'gen/2', sandboxName: 'slopify-worker-2', agent: 'codex', status: 'assigned', taskId: 'active', attemptId: 'att-active', replacements: 1 },
  ];
  const report = taskBatchReport(snapshot);
  assert.deepEqual(report.reliability.workers, {
    occupancy: { available: 1, assigned: 1, cleaning: 0, verifying: 0, retained: 0, retired: 0 },
    replacements: 1,
    detail: 'see the Workers section of this report',
  });
  assert.ok(formatTaskBatchReport(snapshot).includes(
    'Worker occupancy: 1 available, 1 assigned, 0 cleaning, 0 verifying, 0 retained, 0 retired; '
    + 'detailed lifecycle: see the Workers section of this report'),
    'the occupancy summary references the detailed lifecycle');
  const legacy = state([task('done', 'succeeded')]);
  assert.equal(taskBatchReport(legacy).reliability.workers, undefined);
  assert.ok(!formatTaskBatchReport(legacy).includes('Worker occupancy:'));
});
