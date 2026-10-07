import * as path from 'node:path';
import { taskBatchReport, formatTaskBatchReport } from './taskBatchReport.js';
import { TaskBatchService, TaskBatchValidationError, TaskBatchExecutionError, type TaskBatchSnapshot, type TaskBatchServiceOptions } from './taskBatch.js';

export const taskBatchHelp = [
  'Task batches (Pi / Codex):',
  '  slopify tasks run <batch.json> [--cwd <repository>] [--store <directory>] [--base <ref>] [--json]',
  '  slopify tasks status <run-id> [--cwd <repository>] [--store <directory>] [--json]',
  '  slopify tasks resume <run-id> [--cwd <repository>] [--store <directory>] [--json]',
  '  slopify tasks resume-task <run-id> <task-id> [--cwd <repository>] [--store <directory>] [--json]',
  '  slopify tasks resolve-conflict <run-id> [--strategy <use-current|use-incoming|manual>] [--cwd <repository>] [--store <directory>] [--json]',
  '  slopify tasks conflict <run-id> [--cwd <repository>] [--store <directory>] [--json]',
  '  slopify tasks validate-resolution <run-id> <resolution-id> [--cwd <repository>] [--store <directory>] [--json]',
  '  slopify tasks resolution <run-id> [--cwd <repository>] [--store <directory>] [--json]',
  '',
  'Runs execute the first five ready tasks in JSON order, then integrate the entire wave.',
  'Execution exit codes: 0 succeeded, 2 failed/interrupted/conflicted, 1 invalid input or command.',
  'Status and final output include progress, issues, evidence paths and next actions.',
  'During execution progress is written to stderr (JSON lines with --json); stdout keeps one final result.',
  'Running is durable state; inspect sandbox liveness before retrying an interrupted process.',
  'Batch paths are relative to the calling directory; specFile is relative to the batch file.',
].join('\n');


type BatchCliService = Pick<TaskBatchService,
  'run' | 'status' | 'resume' | 'resumeTask' | 'resolveConflict' | 'getConflict' | 'validateResolution' | 'getResolution'>;

export async function runTaskBatchCli(
  argv: string[],
  output: { write(message: string): void; writeError(message: string): void },
  baseCwd = process.cwd(),
  createService: (options: TaskBatchServiceOptions) => BatchCliService = options => new TaskBatchService(options),
): Promise<number> {
  let json = argv.includes('--json');
  let reportStorePath: string | undefined;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  try {
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
      output.write(taskBatchHelp);
      return 0;
    }
    const action = argv[0];
    const actions = ['run', 'status', 'resume', 'resume-task', 'resolve-conflict', 'conflict', 'validate-resolution', 'resolution'];
    if (!actions.includes(action)) throw new Error(`Unknown tasks command "${action}".\n${taskBatchHelp}`);
    let repositoryPath = baseCwd;
    let storePath: string | undefined;
    let baseRef: string | undefined;
    let strategy: 'use-current' | 'use-incoming' | 'manual' | undefined;
    const positional: string[] = [];
    for (let index = 1; index < argv.length; index += 1) {
      const value = argv[index];
      if (value === '--json') { json = true; continue; }
      if (value === '--cwd' || value === '--store' || value === '--base' || value === '--strategy') {
        if (value === '--base' && action !== 'run') throw new Error('--base is only supported by tasks run.');
        if (value === '--strategy' && action !== 'resolve-conflict') throw new Error('--strategy is only supported by tasks resolve-conflict.');
        const next = argv[++index];
        if (!next || next.startsWith('-')) throw new Error(`${value} requires a value.`);
        if (value === '--cwd') repositoryPath = path.resolve(baseCwd, next);
        else if (value === '--store') storePath = path.resolve(baseCwd, next);
        else if (value === '--base') baseRef = next;
        else if (next === 'use-current' || next === 'use-incoming' || next === 'manual') strategy = next;
        else throw new Error(`Invalid strategy: ${next}. Use 'use-current', 'use-incoming', or 'manual'.`);
        continue;
      }
      if (value.startsWith('-')) throw new Error(`Unknown tasks option "${value}".`);
      positional.push(value);
    }
    const arity = action === 'resume-task' || action === 'validate-resolution' ? 2 : 1;
    if (positional.length !== arity) throw new Error(taskBatchHelp);
    reportStorePath = storePath;
    let lastProgress = '';
    const onUpdate = action === 'status' || action === 'conflict' || action === 'resolution' ? undefined
      : (snapshot: TaskBatchSnapshot) => {
        const { progress, issues, nextActions } = taskBatchReport(snapshot, storePath);
        const tasks = snapshot.tasks.map(task => ({ id: task.id, agent: task.agent, status: task.status }));
        const fingerprint = JSON.stringify({ runId: snapshot.runId, status: snapshot.status, progress, issues, tasks, nextActions });
        if (fingerprint === lastProgress) return;
        lastProgress = fingerprint;
        output.writeError(json ? JSON.stringify({ type: 'progress', runId: snapshot.runId, status: snapshot.status,
          updatedAt: snapshot.updatedAt, progress, tasks, issues, nextActions })
          : `Run ${snapshot.runId}: ${snapshot.status} (${progress.phase}); ${progress.counts.succeeded}/${progress.total} integrated; running: ${progress.activeTaskIds.join(', ') || 'none'}; awaiting integration: ${progress.awaitingIntegrationTaskIds.join(', ') || 'none'}\n`
            + tasks.map(task => `${task.id}: ${task.status} (${task.agent})`).join(', ')
            + issues.filter(issue => issue.severity !== 'info' && !issue.historical).map(issue => `\n[${issue.code}] ${issue.taskId ?? 'run'}: ${issue.message}`).join(''));
      };
    const service = createService({ repositoryPath, storePath, onUpdate });
    const [runId, taskId] = positional;
    if (action === 'conflict') {
      const conflict = await service.getConflict(runId);
      output.write(json ? JSON.stringify(conflict ?? null) : conflict
        ? `Conflict in run ${runId}:\n  Task: ${conflict.taskId}\n  Attempt: ${conflict.attemptId}\n  Files: ${conflict.files.join(', ')}\n  Output: ${conflict.output.slice(0, 200)}`
        : `No conflict in run ${runId}.`);
      return 0;
    }
    if (action === 'resolution') {
      const resolution = await service.getResolution(runId);
      output.write(json ? JSON.stringify(resolution ?? null) : resolution
        ? `Resolution for run ${runId}:\n${JSON.stringify(resolution, null, 2)}`
        : `No resolution for run ${runId}.`);
      return 0;
    }
    if (action !== 'status') {
      process.on('SIGINT', interrupt);
      process.on('SIGTERM', interrupt);
    }
    const options = { signal: controller.signal };
    let snapshot: TaskBatchSnapshot;
    switch (action) {
      case 'run': snapshot = await service.run(path.resolve(baseCwd, runId), { ...options, baseRef }); break;
      case 'status': snapshot = await service.status(runId); break;
      case 'resume': snapshot = await service.resume(runId, options); break;
      case 'resume-task': snapshot = await service.resumeTask(runId, taskId, options); break;
      case 'resolve-conflict': snapshot = await service.resolveConflict(runId, { ...options, resolutionStrategy: strategy }); break;
      case 'validate-resolution': snapshot = await service.validateResolution(runId, taskId, options); break;
      default: throw new Error(taskBatchHelp);
    }
    output.write(json ? JSON.stringify(taskBatchReport(snapshot, storePath)) : formatTaskBatchReport(snapshot, storePath));
    return action === 'status' || snapshot.status === 'succeeded' ? 0 : 2;
  } catch (error) {
    if (error instanceof TaskBatchExecutionError) {
      output.write(json ? JSON.stringify({ ...taskBatchReport(error.snapshot, reportStorePath), error: error.message }) : formatTaskBatchReport(error.snapshot, reportStorePath));
      if (!json) output.writeError(error.message);
      return 2;
    }
    if (json) {
      output.write(JSON.stringify({ status: 'invalid', diagnostics: error instanceof TaskBatchValidationError ? error.diagnostics
        : [{ code: 'command_error', message: error instanceof Error ? error.message : String(error) }] }));
    } else {
      output.writeError(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
