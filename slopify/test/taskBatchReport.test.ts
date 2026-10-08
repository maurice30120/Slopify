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
