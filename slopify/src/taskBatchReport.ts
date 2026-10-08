import * as path from 'node:path';
import type { TaskBatchSnapshot, TaskBatchDiagnostic, BatchTaskState } from './taskBatch.js';

export interface BatchIssue extends TaskBatchDiagnostic {
  severity: 'info' | 'warning' | 'error';
  taskId?: string;
  attemptId?: string;
  historical?: boolean;
}
export interface BatchAction {
  description: string;
  command: string[];
  precondition?: string;
}

/** A read-only view of durable state; running means recorded, not verified process liveness. */
export function taskBatchReport(snapshot: TaskBatchSnapshot, storePath?: string) {
  const byId = new Map(snapshot.tasks.map(task => [task.id, task]));
  const counts = { pending: 0, running: 0, completed: 0, succeeded: 0, failed: 0, interrupted: 0, blocked: 0, conflicted: 0 };
  for (const task of snapshot.tasks) counts[task.status]++;
  const activeTaskIds = snapshot.tasks.filter(task => task.status === 'running').map(task => task.id);
  const readyTaskIds = snapshot.tasks.filter(task => task.status === 'pending'
    && task.dependsOn.every(id => byId.get(id)?.status === 'succeeded')).map(task => task.id);
  const waitingOn = snapshot.tasks.filter(task => task.status === 'pending' || task.status === 'blocked')
    .map(task => ({ taskId: task.id, dependencyIds: task.dependsOn.filter(id => byId.get(id)?.status !== 'succeeded') }))
    .filter(task => task.dependencyIds.length > 0);
  const phase = snapshot.conflict ? 'awaiting_resolution'
    : snapshot.status !== 'running' ? snapshot.status
    : counts.running > 0 ? 'executing'
    : counts.completed > 0 ? 'integrating' : 'preparing';
  const progress = {
    phase, total: snapshot.tasks.length, counts, activeTaskIds, readyTaskIds, waitingOn,
    awaitingIntegrationTaskIds: snapshot.tasks.filter(task => task.status === 'completed').map(task => task.id),
  };
  const issues: BatchIssue[] = snapshot.diagnostics.map(diagnostic => ({ ...diagnostic,
    ...(diagnostic.code !== 'host_changes_excluded' && !diagnostic.code.includes('cleanup')
      && (snapshot.status === 'running' || snapshot.status === 'succeeded') ? { historical: true } : {}),
    severity: diagnostic.code === 'host_changes_excluded' ? 'info'
      : diagnostic.code.includes('cleanup') ? 'warning' : 'error',
  }));
  for (const task of snapshot.tasks) {
    const attempt = task.attempts.at(-1);
    for (const diagnostic of attempt?.diagnostics ?? []) {
      issues.push({ ...diagnostic, ...(task.status === 'succeeded' && !diagnostic.code.includes('cleanup') ? { historical: true } : {}), severity: diagnostic.code.includes('cleanup') ? 'warning' : 'error',
        taskId: task.id, attemptId: attempt?.attemptId });
    }
    if ((task.status === 'failed' || task.status === 'interrupted') && !attempt?.diagnostics?.length) {
      issues.push({ code: `task_${task.status}`, severity: 'error', taskId: task.id, attemptId: attempt?.attemptId,
        message: `Task ${task.id} is ${task.status}${attempt?.exitCode !== undefined ? ` (agent exit code ${attempt.exitCode})` : ''}. Inspect its report and logs.` });
    }
    if (task.status === 'blocked') issues.push({ code: 'blocked_dependency', severity: 'error', taskId: task.id,
      message: `Blocked by ${(task.blockedBy ?? task.dependsOn).join(', ')}.` });
  }
  if (snapshot.conflict) issues.push({ code: 'integration_conflict', severity: 'error', taskId: snapshot.conflict.taskId,
    attemptId: snapshot.conflict.attemptId, message: `Integration conflict in ${snapshot.conflict.files.join(', ')}. Explicit resolution required.` });

  const inferredStore = path.isAbsolute(snapshot.context.batchFile)
    ? path.dirname(path.dirname(path.dirname(snapshot.context.batchFile))) : undefined;
  const store = storePath ?? inferredStore;
  const location = ['--cwd', snapshot.repositoryPath, ...(store ? ['--store', store] : [])];
  const command = (action: string, ...args: string[]) => ['slopify', 'tasks', action, snapshot.runId, ...args, ...location];
  const nextActions: BatchAction[] = [];
  if (snapshot.conflict) {
    nextActions.push({ description: 'Inspect the integration conflict', command: command('conflict') });
    if (snapshot.resolution?.status === 'pending') {
      nextActions.push({ description: 'Inspect the manual resolution workspace', command: ['git', '-C', snapshot.resolution.sandboxPath, 'status'] });
      nextActions.push({ description: 'Validate the manual resolution and continue', command: command('validate-resolution', snapshot.resolution.resolutionId),
        precondition: 'Resolve the conflict in the resolution workspace and commit the intended result first.' });
    } else nextActions.push({ description: 'Prepare an explicit manual resolution', command: command('resolve-conflict', '--strategy', 'manual') });
  } else if (snapshot.status === 'succeeded') {
    nextActions.push({ description: 'Inspect the integrated changes', command: ['git', '-C', snapshot.repositoryPath, 'diff', `${snapshot.runBaseCommit}..${snapshot.integrationBranch}`] });
  } else {
    nextActions.push({ description: 'Read the latest durable state', command: command('status', '--json') });
    if (activeTaskIds.length === 0 && (snapshot.status === 'failed' || snapshot.status === 'interrupted')) {
      nextActions.push({ description: 'Explicitly resume the batch', command: command('resume'),
        precondition: 'Inspect the failures and correct their cause before retrying failed tasks.' });
    }
    for (const task of snapshot.tasks) {
      if ((snapshot.status === 'running' && task.status !== 'running') || !['failed', 'interrupted', 'running'].includes(task.status)
        || !task.dependsOn.every(id => byId.get(id)?.status === 'succeeded')
        || activeTaskIds.filter(id => id !== task.id).length >= 5) continue;
      nextActions.push({ description: `Explicitly retry task ${task.id}`, command: command('resume-task', task.id),
        precondition: task.status === 'running' ? 'Running is persisted state, not a liveness check. Verify that the previous Slopify process has ended and the previous agent has stopped before retrying.'
          : 'Inspect the report and correct the failure cause before retrying.' });
    }
  }
  for (const task of snapshot.tasks) {
    const attempt = task.attempts.at(-1);
    if (attempt?.resource && attempt.resourceState !== 'removed') nextActions.push({
      description: `Inspect sandbox for task ${task.id}`, command: attempt.resource.inspectCommand,
    });
  }
  return { ...snapshot, progress, issues, nextActions };
}

export function displayCommand(command: string[]): string {
  return command.map(value => /^[a-zA-Z0-9_./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`).join(' ');
}

function taskDetails(task: BatchTaskState): string[] {
  const attempt = task.attempts.at(-1);
  const lines = [`${task.id}: ${task.status} (${task.agent})${attempt ? ` — attempt ${task.attempts.length}: ${attempt.attemptId}` : ''}`];
  if (task.blockedBy?.length) lines.push(`  Blocked by: ${task.blockedBy.join(', ')}`);
  if (attempt?.exitCode !== undefined) lines.push(`  Agent exit code: ${attempt.exitCode}`);
  if (attempt?.taskBaseCommit) lines.push(`  Task base: ${attempt.taskBaseCommit}`);
  if (attempt?.checkpoint) lines.push(`  Checkpoint: ${attempt.checkpoint.commit}`);
  if (attempt?.integratedCommit) lines.push(`  Integrated commit: ${attempt.integratedCommit}`);
  if (attempt?.reportPath) lines.push(`  Report: ${attempt.reportPath}`);
  if (attempt?.stdoutPath) lines.push(`  Stdout: ${attempt.stdoutPath}`);
  if (attempt?.stderrPath) lines.push(`  Stderr: ${attempt.stderrPath}`);
  if (attempt?.resource) lines.push(`  Sandbox: ${attempt.resource.sandboxName} (${attempt.resourceState ?? 'unknown'})`);
  return lines;
}

export function formatTaskBatchReport(snapshot: TaskBatchSnapshot, storePath?: string): string {
  const report = taskBatchReport(snapshot, storePath);
  const { progress } = report;
  const lines = [
    `Run ${snapshot.runId}: ${snapshot.status} (${progress.phase})`,
    `Progress: ${progress.counts.succeeded}/${progress.total} integrated; ${progress.counts.running} running; ${progress.counts.completed} awaiting integration; ${progress.counts.pending} pending; ${progress.counts.failed} failed; ${progress.counts.interrupted} interrupted; ${progress.counts.blocked} blocked; ${progress.counts.conflicted} conflicted`,
    `Last durable update: ${snapshot.updatedAt}`,
    `Integration branch: ${snapshot.integrationBranch}`,
    `Integration commit: ${snapshot.integrationCommit ?? snapshot.runBaseCommit}`,
    ...snapshot.tasks.flatMap(taskDetails),
    ...progress.waitingOn.map(task => `${task.taskId} waits for: ${task.dependencyIds.join(', ')}`),
    ...report.issues.map(issue => `[${issue.severity}${issue.historical ? ', historical' : ''}] ${issue.code}${issue.taskId ? ` (${issue.taskId})` : ''}: ${issue.message}`),
    ...report.nextActions.flatMap(action => [`Next: ${action.description}`, `  ${displayCommand(action.command)}`,
      ...(action.precondition ? [`  Requires: ${action.precondition}`] : [])]),
  ];
  if (snapshot.resolution) lines.push(`Resolution: ${snapshot.resolution.resolutionId} (${snapshot.resolution.status})`, `Resolution workspace: ${snapshot.resolution.sandboxPath}`);
  return lines.join('\n');
}
