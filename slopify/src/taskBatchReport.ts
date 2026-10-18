import * as path from 'node:path';
import type { TaskBatchSnapshot, TaskBatchDiagnostic, BatchTaskState } from './taskBatch.js';
import type { ActivitySignal } from './activitySignal.js';
import type { TaskWorkerPoolConfig, TaskWorkerState, TaskWorkerStatus } from './taskWorkerPool.js';

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

/** Curated lifecycle view of one worker, keyed by durable worker identity. */
export interface BatchWorkerView {
  workerId: string;
  agent: string;
  status: TaskWorkerStatus;
  taskId?: string;
  attemptId?: string;
  replacements: number;
}

/** Occupancy and turnover of the frozen worker pool, without exposing pool internals. */
export interface BatchWorkerPoolView {
  size: number;
  lifecycle: TaskWorkerPoolConfig['lifecycle'];
  occupancy: Record<TaskWorkerStatus, number>;
  replacements: number;
  workers: BatchWorkerView[];
}

/** A worker replaced during the batch counts every worker taken out of service before its creation. */
function workerPoolView(snapshot: TaskBatchSnapshot): BatchWorkerPoolView | undefined {
  const config = snapshot.workerPoolConfig;
  if (!config) return undefined;
  const workers = snapshot.workers ?? [];
  const occupancy: Record<TaskWorkerStatus, number> = { available: 0, assigned: 0, cleaning: 0, verifying: 0, retained: 0, retired: 0 };
  for (const worker of workers) occupancy[worker.status] += 1;
  return {
    size: config.size,
    lifecycle: config.lifecycle,
    occupancy,
    replacements: Math.max(0, ...workers.map(worker => worker.replacements)),
    workers: workers.map(({ workerId, agent, status, taskId, attemptId, replacements }) =>
      ({ workerId, agent, status, ...(taskId ? { taskId } : {}), ...(attemptId ? { attemptId } : {}), replacements })),
  };
}

/** One readable line per worker; ready, assigned and reset-checking workers stay distinct. */
function describeWorker(worker: BatchWorkerView): string {
  const link = worker.taskId ? `task ${worker.taskId}${worker.attemptId ? ` (attempt ${worker.attemptId})` : ''}` : '';
  switch (worker.status) {
    case 'assigned': return link ? `assigned to ${link}` : 'assigned';
    case 'cleaning': return link ? `cleaning ${link}` : 'cleaning';
    case 'verifying': return link ? `verifying reset of ${link}` : 'verifying';
    case 'retained': return link ? `retained for inspection, ${link}` : 'retained for inspection';
    case 'retired': return 'retired';
    default: return 'available';
  }
}

function formatWorkerPool(pool: BatchWorkerPoolView): string[] {
  const occupancy = Object.entries(pool.occupancy).map(([status, count]) => `${count} ${status}`).join(', ');
  return [
    `Workers: ${pool.size} configured, lifecycle ${pool.lifecycle}; occupancy: ${occupancy}; ${pool.replacements} replacement${pool.replacements === 1 ? '' : 's'} during this run`,
    ...pool.workers.map(worker => `  ${worker.workerId} (${worker.agent}): ${describeWorker(worker)}`),
  ];
}

export interface TaskBatchWatchUpdate {
  type: 'watch-update';
  initial: boolean;
  runId: string;
  status: TaskBatchSnapshot['status'];
  progress: ReturnType<typeof taskBatchReport>['progress'];
  tasks: Array<{ id: string; status: BatchTaskState['status'] }>;
  changes: Array<{ taskId: string; from?: BatchTaskState['status']; to: BatchTaskState['status'] }>;
  issues: BatchIssue[];
  activitySignals: ActivitySignal[];
  nextActions?: BatchAction[];
}

const TERMINAL_RUN_STATUSES: ReadonlySet<TaskBatchSnapshot['status']> = new Set([
  'succeeded', 'failed', 'interrupted', 'conflicted',
]);

export function isTerminalTaskBatchStatus(status: TaskBatchSnapshot['status']): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/** A read-only view of durable state; running means recorded, not verified process liveness. */
export function taskBatchReport(snapshot: TaskBatchSnapshot, storePath?: string, activitySignals?: ActivitySignal[]) {
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
  const workerPool = workerPoolView(snapshot);
  return { ...snapshot, progress, issues, nextActions,
    ...(workerPool ? { workerPool } : {}), ...(activitySignals?.length ? { activitySignals } : {}) };
}

/** Compact state transition for `tasks watch`; updatedAt is deliberately excluded from the fingerprint. */
export function taskBatchWatchUpdate(
  snapshot: TaskBatchSnapshot,
  storePath: string | undefined,
  previousStatuses: Map<string, BatchTaskState['status']> | undefined,
  journalActivitySignals: ActivitySignal[],
  newActivitySignals: ActivitySignal[],
): { update: TaskBatchWatchUpdate; fingerprint: string } {
  const report = taskBatchReport(snapshot, storePath, journalActivitySignals);
  const tasks = snapshot.tasks.map(task => ({ id: task.id, status: task.status }));
  const changes = previousStatuses
    ? tasks.filter(task => previousStatuses.get(task.id) !== task.status).map(task => ({
      taskId: task.id, from: previousStatuses.get(task.id), to: task.status,
    }))
    : tasks.map(task => ({ taskId: task.id, to: task.status }));
  const update: TaskBatchWatchUpdate = {
    type: 'watch-update',
    initial: previousStatuses === undefined,
    runId: snapshot.runId,
    status: snapshot.status,
    progress: report.progress,
    tasks,
    changes,
    issues: report.issues.filter(issue => issue.severity !== 'info' && !issue.historical),
    activitySignals: newActivitySignals,
    ...(isTerminalTaskBatchStatus(snapshot.status)
      ? { nextActions: report.nextActions } : {}),
  };
  const fingerprint = JSON.stringify({
    status: snapshot.status,
    progress: report.progress,
    tasks,
    issues: report.issues,
    conflict: snapshot.conflict,
    resolution: snapshot.resolution?.status,
    activitySignals: journalActivitySignals,
  });
  return { update, fingerprint };
}

/** One readable summary per meaningful state change in `tasks watch`. */
export function formatTaskBatchWatchUpdate(update: TaskBatchWatchUpdate): string {
  const { progress } = update;
  const lines = [
    `Run ${update.runId}: ${update.status} (${progress.phase}); ${progress.counts.succeeded}/${progress.total} integrated; ${progress.counts.running} running; ${progress.counts.pending} pending; ${progress.counts.failed} failed; ${progress.counts.blocked} blocked; ${progress.counts.interrupted} interrupted; ${progress.counts.conflicted} conflicted`,
  ];
  if (update.initial) {
    if (progress.activeTaskIds.length) lines.push(`Active: ${progress.activeTaskIds.join(', ')}`);
    if (progress.readyTaskIds.length) lines.push(`Ready: ${progress.readyTaskIds.join(', ')}`);
    const failed = update.tasks.filter(task => ['failed', 'blocked', 'interrupted', 'conflicted'].includes(task.status));
    if (failed.length) lines.push(`Needs attention: ${failed.map(task => `${task.id} (${task.status})`).join(', ')}`);
  } else if (update.changes.length) {
    lines.push(`Tasks changed: ${update.changes.map(change => `${change.taskId} ${change.from ?? 'new'} → ${change.to}`).join(', ')}`);
  }
  for (const issue of update.issues) lines.push(`[${issue.severity}] ${issue.code}${issue.taskId ? ` (${issue.taskId})` : ''}: ${issue.message}`);
  lines.push(...formatActivitySignalWindow(update.activitySignals));
  for (const action of update.nextActions ?? []) lines.push(`Next: ${action.description}\n  ${displayCommand(action.command)}`);
  return lines.join('\n');
}

/**
 * Fenêtre de rattrapage du `tasks status` (ADR 0013) : une ligne lisible par Signal
 * d’activité, horodatée, dans l’ordre d’émission du journal ; vide si aucun signal.
 */
export function formatActivitySignalWindow(signals: ActivitySignal[]): string[] {
  if (signals.length === 0) return [];
  return ['Recent activity signals:', ...signals.map(signal => {
    const phrases = [
      ...signal.tasks.map(task => `${task.taskId} : ${task.sentence}`),
      ...(signal.grouped ? [`${signal.grouped.taskIds.join(', ')} : ${signal.grouped.sentence}`] : []),
      ...(signal.integration ? [`intégration : ${signal.integration.sentence}`] : []),
    ];
    return `  [${signal.timestamp}] ${phrases.join('; ')}`;
  })];
}

export function displayCommand(command: string[]): string {
  return command.map(value => /^[a-zA-Z0-9_./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`).join(' ');
}

function taskDetails(task: BatchTaskState): string[] {
  const attempt = task.attempts.at(-1);
  const config = [task.agent, task.model, task.effort ? `effort ${task.effort}` : undefined].filter(Boolean).join(', ');
  const lines = [`${task.id}: ${task.status} (${config})${attempt ? ` — attempt ${task.attempts.length}: ${attempt.attemptId}` : ''}`];
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

export function formatTaskBatchReport(snapshot: TaskBatchSnapshot, storePath?: string, activitySignals?: ActivitySignal[]): string {
  const report = taskBatchReport(snapshot, storePath);
  const { progress } = report;
  const lines = [
    `Run ${snapshot.runId}: ${snapshot.status} (${progress.phase})`,
    `Progress: ${progress.counts.succeeded}/${progress.total} integrated; ${progress.counts.running} running; ${progress.counts.completed} awaiting integration; ${progress.counts.pending} pending; ${progress.counts.failed} failed; ${progress.counts.interrupted} interrupted; ${progress.counts.blocked} blocked; ${progress.counts.conflicted} conflicted`,
    `Last durable update: ${snapshot.updatedAt}`,
    `Integration branch: ${snapshot.integrationBranch}`,
    `Integration commit: ${snapshot.integrationCommit ?? snapshot.runBaseCommit}`,
    ...formatActivitySignalWindow(activitySignals ?? []),
    ...snapshot.tasks.flatMap(taskDetails),
    ...(report.workerPool ? formatWorkerPool(report.workerPool) : []),
    ...progress.waitingOn.map(task => `${task.taskId} waits for: ${task.dependencyIds.join(', ')}`),
    ...report.issues.map(issue => `[${issue.severity}${issue.historical ? ', historical' : ''}] ${issue.code}${issue.taskId ? ` (${issue.taskId})` : ''}: ${issue.message}`),
    ...report.nextActions.flatMap(action => [`Next: ${action.description}`, `  ${displayCommand(action.command)}`,
      ...(action.precondition ? [`  Requires: ${action.precondition}`] : [])]),
  ];
  if (snapshot.resolution) lines.push(`Resolution: ${snapshot.resolution.resolutionId} (${snapshot.resolution.status})`, `Resolution workspace: ${snapshot.resolution.sandboxPath}`);
  return lines.join('\n');
}
