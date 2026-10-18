import * as path from 'node:path';
import type { TaskBatchSnapshot, TaskBatchDiagnostic, BatchTaskState } from './taskBatch.js';
import type { ActivitySignal } from './activitySignal.js';
import type { TaskWorkerPoolConfig, TaskWorkerState, TaskWorkerStatus } from './taskWorkerPool.js';

/** Durable task status tally; every manifest task is counted exactly once. */
type BatchTaskCounts = Record<BatchTaskState['status'], number>;

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
  /** Occupancy by status is the source of truth; replacements only count failure-driven turnover that a new worker restored. */
  replacements: number;
  workers: BatchWorkerView[];
}

/**
 * Real replacements of the batch (#108): a worker driven out of service by a failure
 * (a retained attempt or a failed reset) whose capacity was restored by a new worker.
 * Agent-frontier swaps of idle workers and planned lifecycle recycling never count.
 * Each pool generation carries its own cumulative total on its last created worker,
 * so replacements sum across resumed sessions; occupancy by status stays the truth.
 */
function replacementTotal(workers: BatchWorkerView[]): number {
  const byGeneration = new Map<string, number>();
  for (const worker of workers) {
    const separator = worker.workerId.lastIndexOf('/');
    const generation = separator < 0 ? worker.workerId : worker.workerId.slice(0, separator);
    byGeneration.set(generation, Math.max(byGeneration.get(generation) ?? 0, worker.replacements));
  }
  let total = 0;
  for (const count of byGeneration.values()) total += count;
  return total;
}

/** Reliability summary of the batch (#111): failures, retries, stops and diagnostics. */
export interface BatchReliabilityView {
  /** Tasks whose current durable status is failed. */
  failedTaskIds: string[];
  /** Tasks stopped without a task decision, by an interruption. */
  interruptedTaskIds: string[];
  attempts: { total: number; retries: number; retriedTaskIds: string[] };
  /** Occupancy snapshot of the frozen pool, deferring to the detailed worker lifecycle. */
  workers?: { occupancy: Record<TaskWorkerStatus, number>; replacements: number; detail: 'see the Workers section of this report' };
  /** Durable checkpoint integrity checks, split into valid, invalid and incomplete (#110). */
  checkpoints: {
    valid: Array<{ taskId: string; attemptId: string }>;
    invalid: Array<{ taskId: string; attemptId: string; reason?: string }>;
    incomplete: Array<{ taskId: string; attemptId: string; reason?: string }>;
  };
  /** Consolidated inspection view (#109): the sandbox, worktree and checkpoint kept of every retained attempt. */
  retainedForInspection?: Array<{ taskId: string; attemptId: string; sandboxName?: string; worktreePath?: string; checkpointBundlePath?: string }>;
  /** Why the batch stopped, kept separate from task-local failures (#109). */
  stop: {
    kind: 'none' | 'integration_conflict' | 'docker_outage' | 'operator_interruption' | 'task_failures';
    message: string;
  };
  /** Wall clock between durable creation and last update; diagnostic only, never a success criterion. */
  wallClockMs?: number;
  /** Manifest accounting (#111): every declared task stays counted, including the generated final review. */
  manifest: { batchTasks: number; finalReview: number; total: number; counted: number };
}

/** A worker replaced during the batch counts every worker taken out of service before its creation. */
function workerPoolView(snapshot: TaskBatchSnapshot): BatchWorkerPoolView | undefined {
  const config = snapshot.workerPoolConfig;
  if (!config) return undefined;
  const workers = snapshot.workers ?? [];
  const occupancy: Record<TaskWorkerStatus, number> = { available: 0, assigned: 0, cleaning: 0, verifying: 0, retained: 0, retired: 0 };
  for (const worker of workers) occupancy[worker.status] += 1;
  const views: BatchWorkerView[] = workers.map(({ workerId, agent, status, taskId, attemptId, replacements }) =>
    ({ workerId, agent, status, ...(taskId ? { taskId } : {}), ...(attemptId ? { attemptId } : {}), replacements }));
  return {
    size: config.size,
    lifecycle: config.lifecycle,
    occupancy,
    replacements: replacementTotal(views),
    workers: views,
  };
}

/**
 * Reliability summary of the batch (#111): failures, retries, worker occupancy,
 * checkpoint integrity, batch-level stops, wall clock and manifest accounting.
 */
function reliabilityView(snapshot: TaskBatchSnapshot, counts: BatchTaskCounts,
  workerPool?: BatchWorkerPoolView): BatchReliabilityView {
  const failedTaskIds = snapshot.tasks.filter(task => task.status === 'failed').map(task => task.id);
  const interruptedTaskIds = snapshot.tasks.filter(task => task.status === 'interrupted').map(task => task.id);
  const attempts = snapshot.tasks.flatMap(task => task.attempts);
  const retriedTaskIds = snapshot.tasks.filter(task => task.attempts.length > 1).map(task => task.id);
  return {
    failedTaskIds, interruptedTaskIds,
    attempts: { total: attempts.length, retries: Math.max(0, attempts.length
      - snapshot.tasks.filter(task => task.attempts.length > 0).length), retriedTaskIds },
    ...(workerPool ? { workers: { occupancy: { ...workerPool.occupancy }, replacements: workerPool.replacements,
      detail: 'see the Workers section of this report' as const } } : {}),
    checkpoints: checkpointIntegrityView(snapshot),
    ...(retainedForInspectionView(snapshot) ? { retainedForInspection: retainedForInspectionView(snapshot) } : {}),
    stop: stopView(snapshot, failedTaskIds),
    ...(wallClockMs(snapshot) !== undefined ? { wallClockMs: wallClockMs(snapshot) } : {}),
    manifest: manifestView(snapshot, counts),
  };

/**
 * Manifest accounting: the batch never shrinks its workload to look faster —
 * every task of the frozen manifest plus the generated final review stays
 * counted, and `counted` proves that no task status is hidden from the report.
 */
function manifestView(snapshot: TaskBatchSnapshot, counts: BatchTaskCounts): BatchReliabilityView['manifest'] {
  const finalReview = snapshot.tasks.filter(task => task.source === 'final-review').length;
  const counted = Object.values(counts).reduce((total, count) => total + count, 0);
  return { batchTasks: snapshot.tasks.length - finalReview, finalReview, total: snapshot.tasks.length, counted };
}
}

/** Consolidated inspection view (#109): one entry per attempt whose resources were kept for diagnosis. */
function retainedForInspectionView(snapshot: TaskBatchSnapshot): BatchReliabilityView['retainedForInspection'] {
  const retained: NonNullable<BatchReliabilityView['retainedForInspection']> = [];
  for (const task of snapshot.tasks) {
    for (const attempt of task.attempts) {
      if (attempt.resourceState !== 'retained') continue;
      retained.push({
        taskId: task.id, attemptId: attempt.attemptId,
        ...(attempt.resource?.sandboxName ? { sandboxName: attempt.resource.sandboxName } : {}),
        ...(attempt.resource?.worktreePath ? { worktreePath: attempt.resource.worktreePath } : {}),
        ...(attempt.checkpoint?.bundlePath ? { checkpointBundlePath: attempt.checkpoint.bundlePath } : {}),
      });
    }
  }
  return retained.length > 0 ? retained : undefined;
}

/** Retained-for-inspection lines; hidden while nothing is kept for diagnosis. */
function formatRetainedForInspection(reliability: BatchReliabilityView): string[] {
  const retained = reliability.retainedForInspection;
  if (!retained?.length) return [];
  const details = retained.map(entry => {
    const parts = [entry.sandboxName ? `sandbox ${entry.sandboxName}` : undefined,
      entry.worktreePath ? `worktree ${entry.worktreePath}` : undefined,
      entry.checkpointBundlePath ? `checkpoint bundle ${entry.checkpointBundlePath}` : undefined]
      .filter(Boolean).join('; ');
    return `  ${entry.taskId} (${entry.attemptId}): ${parts}`;
  });
  return [`Retained for inspection: ${retained.length} attempt${retained.length === 1 ? '' : 's'} kept for diagnosis`, ...details];
}

/** Wall clock from durable timestamps; undefined when legacy state lacks usable dates. */
function wallClockMs(snapshot: TaskBatchSnapshot): number | undefined {
  const created = Date.parse(snapshot.createdAt);
  const updated = Date.parse(snapshot.updatedAt);
  if (Number.isNaN(created) || Number.isNaN(updated) || updated < created) return undefined;
  return updated - created;
}

/**
 * Batch-level stop reason: an integration conflict or a shared Docker outage
 * stopped the whole batch and must never be read as a task failure.
 */
function stopView(snapshot: TaskBatchSnapshot, failedTaskIds: string[]): BatchReliabilityView['stop'] {
  const failures = `${failedTaskIds.length} task failure${failedTaskIds.length === 1 ? '' : 's'}`
    + `${failedTaskIds.length ? ` (${failedTaskIds.join(', ')})` : ''}`;
  if (snapshot.conflict) return { kind: 'integration_conflict',
    message: `Batch stopped by an integration conflict in task ${snapshot.conflict.taskId}; explicit resolution required. `
      + `This stop is not a task failure; ${failures}.` };
  if (snapshot.suspension) return { kind: 'docker_outage',
    message: `Batch suspended by a shared Docker control failure detected at ${snapshot.suspension.detectedAt}; `
      + `this is a common outage, not a task failure; ${failures}.` };
  if (snapshot.status === 'interrupted') return { kind: 'operator_interruption',
    message: `Batch interrupted by an operator or coordinator stop; this is not a task failure; ${failures}.` };
  if (snapshot.status === 'failed') return { kind: 'task_failures',
    message: `Batch ended by task failures${failedTaskIds.length ? ` (${failedTaskIds.join(', ')})` : ''}; `
      + `no conflict or shared outage stopped this batch.` };
  return { kind: 'none',
    message: failedTaskIds.length ? `No batch-level stop recorded; ${failures} ${failedTaskIds.length === 1 ? 'is' : 'are'} task-local.`
      : 'No batch-level stop and no task failure recorded.' };
}

/** Every recorded integrity check of every attempt, keyed by its durable outcome. */
function checkpointIntegrityView(snapshot: TaskBatchSnapshot): BatchReliabilityView['checkpoints'] {
  const view: BatchReliabilityView['checkpoints'] = { valid: [], invalid: [], incomplete: [] };
  for (const task of snapshot.tasks) {
    for (const attempt of task.attempts) {
      const integrity = attempt.checkpointIntegrity;
      if (!integrity) continue;
      const entry = { taskId: task.id, attemptId: attempt.attemptId, ...(integrity.reason ? { reason: integrity.reason } : {}) };
      if (integrity.status === 'valid') view.valid.push({ taskId: task.id, attemptId: attempt.attemptId });
      else view[integrity.status].push(entry);
    }
  }
  return view;
}

/** Checkpoint integrity line; hidden while no resume has run any integrity check. */
function formatCheckpointIntegrity(reliability: BatchReliabilityView): string[] {
  const { valid, invalid, incomplete } = reliability.checkpoints;
  if (valid.length + invalid.length + incomplete.length === 0) return [];
  const detail = (entries: Array<{ taskId: string; reason?: string }>) =>
    entries.map(entry => entry.reason ? `${entry.taskId}: ${entry.reason}` : entry.taskId).join(', ');
  return [`Checkpoints: ${valid.length} valid (${detail(valid)}), `
    + `${invalid.length} invalid (${detail(invalid)}), ${incomplete.length} incomplete (${detail(incomplete)})`];
}

/** One rendered reliability line; plural forms stay readable for 0, 1 and many. */
/** Occupancy line of the reliability summary; the per-worker lifecycle lives in the Workers section. */
function formatWorkerOccupancy(reliability: BatchReliabilityView): string[] {
  if (!reliability.workers) return [];
  const occupancy = Object.entries(reliability.workers.occupancy).map(([status, count]) => `${count} ${status}`).join(', ');
  return [`Worker occupancy: ${occupancy}; detailed lifecycle: ${reliability.workers.detail}`];
}

function formatReliability(reliability: BatchReliabilityView): string {
  const failed = `${reliability.failedTaskIds.length} failed task${reliability.failedTaskIds.length === 1 ? '' : 's'}`;
  const interrupted = `${reliability.interruptedTaskIds.length} interrupted`;
  const retries = `${reliability.attempts.retries} retr${reliability.attempts.retries === 1 ? 'y' : 'ies'}`;
  const retried = reliability.attempts.retriedTaskIds.length ? ` (${reliability.attempts.retriedTaskIds.join(', ')})` : '';
  return `Reliability: ${failed}${reliability.failedTaskIds.length ? ` (${reliability.failedTaskIds.join(', ')})` : ''}; `
    + `${interrupted}${reliability.interruptedTaskIds.length ? ` (${reliability.interruptedTaskIds.join(', ')})` : ''}; `
    + `${reliability.attempts.total} attempt${reliability.attempts.total === 1 ? '' : 's'}, ${retries}${retried}`;
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
  const counts: BatchTaskCounts = { pending: 0, running: 0, completed: 0, succeeded: 0, failed: 0, interrupted: 0, blocked: 0, conflicted: 0 };
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
  return { ...snapshot, progress, issues, nextActions, reliability: reliabilityView(snapshot, counts, workerPool),
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
  if (attempt?.checkpoint?.bundlePath) lines.push(`  Checkpoint bundle: ${attempt.checkpoint.bundlePath}`);
  if (attempt?.integratedCommit) lines.push(`  Integrated commit: ${attempt.integratedCommit}`);
  if (attempt?.reportPath) lines.push(`  Report: ${attempt.reportPath}`);
  if (attempt?.stdoutPath) lines.push(`  Stdout: ${attempt.stdoutPath}`);
  if (attempt?.stderrPath) lines.push(`  Stderr: ${attempt.stderrPath}`);
  if (attempt?.resource) lines.push(`  Sandbox: ${attempt.resource.sandboxName} (${attempt.resourceState ?? 'unknown'})`);
  if (attempt?.resource?.workerId) lines.push(`  Worker: ${attempt.resource.workerId}`);
  if (attempt?.resource?.worktreePath) lines.push(`  Worktree: ${attempt.resource.worktreePath}`);
  return lines;
}

export function formatTaskBatchReport(snapshot: TaskBatchSnapshot, storePath?: string, activitySignals?: ActivitySignal[]): string {
  const report = taskBatchReport(snapshot, storePath);
  const { progress } = report;
  const lines = [
    `Run ${snapshot.runId}: ${snapshot.status} (${progress.phase})`,
    `Progress: ${progress.counts.succeeded}/${progress.total} integrated; ${progress.counts.running} running; ${progress.counts.completed} awaiting integration; ${progress.counts.pending} pending; ${progress.counts.failed} failed; ${progress.counts.interrupted} interrupted; ${progress.counts.blocked} blocked; ${progress.counts.conflicted} conflicted`,
    `Last durable update: ${snapshot.updatedAt}`,
    formatReliability(report.reliability),
    ...formatWorkerOccupancy(report.reliability),
    ...formatCheckpointIntegrity(report.reliability),
    ...formatRetainedForInspection(report.reliability),
    `Stop reason: ${report.reliability.stop.message}`,
    ...(report.reliability.wallClockMs !== undefined
      ? [`Wall clock: ${report.reliability.wallClockMs} ms (diagnostic only; no time threshold can fail the batch)`] : []),
    `Manifest: ${report.reliability.manifest.batchTasks} manifest task${report.reliability.manifest.batchTasks === 1 ? '' : 's'} `
      + `+ ${report.reliability.manifest.finalReview} final review = ${report.reliability.manifest.total} task${report.reliability.manifest.total === 1 ? '' : 's'}, `
      + `${report.reliability.manifest.counted} accounted; coverage is never hidden to look faster`,
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
