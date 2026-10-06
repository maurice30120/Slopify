import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { createNodeSubprocessExecutor, type SubprocessExecutor } from '@acp-client/sandbox';
import { DockerTaskExecutor } from './dockerTaskExecutor.js';
import type { TaskExecutionResult, TaskSandboxResource } from './taskExecution.js';

export interface TaskBatchDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export class TaskBatchValidationError extends Error {
  constructor(readonly diagnostics: TaskBatchDiagnostic[]) {
    super(diagnostics.map((d) => `${d.path ? `${d.path}: ` : ''}${d.message}`).join('\n'));
    this.name = 'TaskBatchValidationError';
  }
}

export interface TaskBatchServiceOptions {
  repositoryPath: string;
  storePath?: string;
  subprocessExecutor?: SubprocessExecutor;
}

export interface TaskBatchRunOptions {
  baseRef?: string;
  execute?: boolean;
  signal?: AbortSignal;
}

export interface BatchTaskAttempt extends Partial<TaskExecutionResult> {
  attemptId: string;
  taskBaseCommit: string;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  resourceState?: 'active' | 'retained' | 'removed';
  integratedCommit?: string;
}

export interface BatchTaskState extends BatchTask {
  status: 'pending' | 'running' | 'completed' | 'conflicted' | 'succeeded' | 'failed' | 'interrupted' | 'blocked';
  attempts: BatchTaskAttempt[];
  blockedBy?: string[];
}

export interface TaskBatchConflict {
  taskId: string;
  attemptId: string;
  taskBaseCommit: string;
  currentCommit: string;
  incomingCommit: string;
  files: string[];
  output: string;
}

export interface TaskBatchSnapshot {
  version: 1;
  runId: string;
  repositoryPath: string;
  status: 'ready' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'conflicted';
  runBaseCommit: string;
  integrationCommit?: string;
  integrationBranch: string;
  createdAt: string;
  updatedAt: string;
  context: { specFile: string; specText: string; batchFile: string };
  tasks: BatchTaskState[];
  diagnostics: TaskBatchDiagnostic[];
  conflict?: TaskBatchConflict;
}

const execFileAsync = promisify(execFile);

/** Public V2 seam: validation and durable context never enter the V1 pipeline runtime. */
export class TaskBatchService {
  readonly repositoryPath: string;
  readonly storePath: string;
  private readonly subprocessExecutor: SubprocessExecutor;
  private readonly saves = new Map<string, Promise<void>>();

  constructor(options: TaskBatchServiceOptions) {
    this.repositoryPath = path.resolve(options.repositoryPath);
    this.subprocessExecutor = options.subprocessExecutor ?? createNodeSubprocessExecutor();
    this.storePath = path.resolve(options.storePath ?? process.env.SLOPIFY_TASK_STORE ?? path.join(
      homedir(), '.local', 'share', 'slopify', 'task-runs',
      createHash('sha256').update(this.repositoryPath).digest('hex').slice(0, 16),
    ));
  }

  async run(batchFile: string, options: TaskBatchRunOptions = {}): Promise<TaskBatchSnapshot> {
    const file = path.resolve(batchFile);
    let raw: string;
    try { raw = await readFile(file, 'utf8'); }
    catch (error) {
      throw new TaskBatchValidationError([{ code: 'unreadable_batch', path: file, message: error instanceof Error ? error.message : String(error) }]);
    }
    let input: unknown;
    try { input = JSON.parse(raw); }
    catch { throw new TaskBatchValidationError([{ code: 'invalid_json', message: 'Batch must contain valid JSON.', path: file }]); }
    const batch = validateBatch(input);
    const specFile = path.resolve(path.dirname(file), batch.specFile);
    let specText: string;
    try { specText = await readFile(specFile, 'utf8'); }
    catch (error) {
      throw new TaskBatchValidationError([{
        code: 'unreadable_spec', path: 'specFile',
        message: `Cannot read specification "${specFile}": ${error instanceof Error ? error.message : String(error)}`,
      }]);
    }
    let runBaseCommit: string;
    try {
      const baseRef = options.baseRef ?? 'HEAD';
      runBaseCommit = (await execFileAsync('git', ['-C', this.repositoryPath, 'rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`])).stdout.trim();
    } catch (error) {
      throw new TaskBatchValidationError([{ code: 'invalid_base', path: 'baseRef', message: `Cannot resolve the run base commit: ${error instanceof Error ? error.message : String(error)}` }]);
    }
    const runId = randomUUID();
    const runDirectory = path.join(this.storePath, runId);
    const contextDirectory = path.join(runDirectory, 'context');
    await mkdir(contextDirectory, { recursive: true, mode: 0o700 });
    const frozenSpecFile = path.join(contextDirectory, 'spec.md');
    const frozenBatchFile = path.join(contextDirectory, 'batch.json');
    await writeFile(frozenSpecFile, specText, { mode: 0o600 });
    await writeFile(frozenBatchFile, JSON.stringify({ ...batch, specFile: 'spec.md' }, null, 2), { mode: 0o600 });
    const now = new Date().toISOString();
    const snapshot: TaskBatchSnapshot = {
      version: 1, runId, repositoryPath: this.repositoryPath, status: 'ready', runBaseCommit,
      integrationBranch: `feature/slopify-${runId}`, createdAt: now, updatedAt: now,
      context: { specFile: frozenSpecFile, specText, batchFile: frozenBatchFile },
      tasks: batch.tasks.map((task) => ({ ...task, status: 'pending', attempts: [] })), diagnostics: [],
    };
    await this.save(snapshot);
    if (options.execute !== false) await this.executeWaves(snapshot, options.signal);
    return snapshot;
  }

  private async save(snapshot: TaskBatchSnapshot): Promise<void> {
    snapshot.updatedAt = new Date().toISOString();
    const file = path.join(this.storePath, snapshot.runId, 'state.json');
    const contents = JSON.stringify(snapshot, null, 2);
    const previous = this.saves.get(snapshot.runId) ?? Promise.resolve();
    const current = previous.then(async () => {
      await writeFile(file + '.tmp', contents, { mode: 0o600 });
      await rename(file + '.tmp', file);
    });
    this.saves.set(snapshot.runId, current);
    try { await current; }
    finally { if (this.saves.get(snapshot.runId) === current) this.saves.delete(snapshot.runId); }
  }

  private async executeWaves(snapshot: TaskBatchSnapshot, signal?: AbortSignal): Promise<void> {
    const runDirectory = path.join(this.storePath, snapshot.runId);
    const workspacePath = path.join(runDirectory, 'integration');
    const executor = new DockerTaskExecutor({ executor: this.subprocessExecutor });
    snapshot.status = 'running';
    await this.save(snapshot);
    try {
      await execFileAsync('git', ['clone', '--no-hardlinks', '--quiet', '--', this.repositoryPath, workspacePath]);
      await execFileAsync('git', ['-C', workspacePath, 'checkout', '--detach', snapshot.runBaseCommit]);
      await execFileAsync('git', ['-C', workspacePath, 'branch', snapshot.integrationBranch, snapshot.runBaseCommit]);
      await this.publish(snapshot, workspacePath);
      snapshot.integrationCommit = snapshot.runBaseCommit;
      snapshot.diagnostics.push({ code: 'host_changes_excluded', message: 'Uncommitted user changes are excluded; the private checkout starts from ' + snapshot.runBaseCommit + '.' });
      await this.save(snapshot);

      while (!signal?.aborted) {
        this.blockDescendants(snapshot);
        const byId = new Map(snapshot.tasks.map(task => [task.id, task]));
        const wave = snapshot.tasks.filter(task => task.status === 'pending'
          && task.dependsOn.every(id => byId.get(id)!.status === 'succeeded'));
        if (wave.length === 0) break;
        const taskBaseCommit = snapshot.integrationCommit!;
        // Each attempt has its own clone and checkpoint refs. Siblings share only their fixed base.
        await Promise.all(wave.map(task => this.executeTask(snapshot, task, taskBaseCommit, workspacePath, executor, signal)));
        // Declaration order is stable even if the external agents finish in a different order.
        for (const task of wave) {
          if (task.status !== 'completed') continue;
          await this.integrateTask(snapshot, task, workspacePath, executor);
          if (snapshot.conflict) return;
        }
        await execFileAsync('git', ['-C', workspacePath, 'checkout', '--detach', snapshot.integrationCommit!]);
        await this.save(snapshot);
      }
      this.blockDescendants(snapshot);
      snapshot.status = snapshot.tasks.every(task => task.status === 'succeeded') ? 'succeeded'
        : signal?.aborted || snapshot.tasks.some(task => task.status === 'interrupted') ? 'interrupted' : 'failed';
      await this.save(snapshot);
    } catch (error) {
      snapshot.status = signal?.aborted ? 'interrupted' : 'failed';
      snapshot.diagnostics.push({ code: 'integration_failed', message: error instanceof Error ? error.message : String(error) });
      await this.save(snapshot);
    }
  }

  private blockDescendants(snapshot: TaskBatchSnapshot): void {
    const byId = new Map(snapshot.tasks.map(task => [task.id, task]));
    let changed: boolean;
    do {
      changed = false;
      for (const task of snapshot.tasks) {
        if (task.status !== 'pending') continue;
        const blockedBy = task.dependsOn.filter(id => ['failed', 'interrupted', 'blocked'].includes(byId.get(id)!.status));
        if (blockedBy.length) { task.status = 'blocked'; task.blockedBy = blockedBy; changed = true; }
      }
    } while (changed);
  }

  private async executeTask(snapshot: TaskBatchSnapshot, task: BatchTaskState, taskBaseCommit: string,
    integrationPath: string, executor: DockerTaskExecutor, signal?: AbortSignal): Promise<void> {
    const attemptId = randomUUID();
    const runDirectory = path.join(this.storePath, snapshot.runId);
    const workspacePath = path.join(runDirectory, 'workspaces', attemptId);
    const resultDirectory = path.join(runDirectory, 'attempts', attemptId);
    const attempt: BatchTaskAttempt = { attemptId, taskBaseCommit, status: 'running' };
    task.attempts.push(attempt); task.status = 'running';
    await this.save(snapshot);
    try {
      await mkdir(path.dirname(workspacePath), { recursive: true });
      await execFileAsync('git', ['clone', '--no-hardlinks', '--quiet', '--', integrationPath, workspacePath]);
      await execFileAsync('git', ['-C', workspacePath, 'checkout', '--detach', taskBaseCommit]);
      const result = await executor.execute({ runId: snapshot.runId, taskId: task.id, attemptId, agent: task.agent,
        workspacePath, specFile: snapshot.context.specFile, prompt: task.prompt, taskBaseCommit,
        runBaseCommit: snapshot.runBaseCommit, resultDirectory, signal,
        onResource: async (resource: TaskSandboxResource) => {
          attempt.resource = resource; attempt.resourceState = 'active'; await this.save(snapshot);
        } });
      Object.assign(attempt, result);
      attempt.resourceState = result.resource ? 'retained' : undefined;
      if (result.exitCode !== 0 || !result.checkpoint) {
        task.status = signal?.aborted ? 'interrupted' : 'failed'; attempt.status = task.status;
      } else { task.status = 'completed'; attempt.status = 'succeeded'; }
    } catch (error) {
      task.status = signal?.aborted ? 'interrupted' : 'failed'; attempt.status = task.status;
      attempt.resourceState = attempt.resource ? 'retained' : undefined;
      attempt.diagnostics = [...attempt.diagnostics ?? [], { code: 'execution_failed', message: String(error) }];
    }
    await this.save(snapshot);
  }

  private async integrateTask(snapshot: TaskBatchSnapshot, task: BatchTaskState, workspacePath: string,
    executor: DockerTaskExecutor): Promise<void> {
    const attempt = task.attempts.at(-1)!;
    const checkpoint = attempt.checkpoint!;
    try {
      await execFileAsync('git', ['-C', workspacePath, 'fetch', '--no-tags', checkpoint.bundlePath, checkpoint.commit]);
      await execFileAsync('git', ['-C', workspacePath, 'merge-base', '--is-ancestor', attempt.taskBaseCommit, checkpoint.commit]);
      const current = snapshot.integrationCommit!;
      let integratedCommit = checkpoint.commit;
      if (current !== attempt.taskBaseCommit) {
        let output: string;
        try {
          output = (await execFileAsync('git', ['-C', workspacePath, 'merge-tree', '--write-tree', '--name-only', '-z', current, checkpoint.commit])).stdout;
        } catch (error) {
          const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
          if (failure.code !== 1) throw error;
          output = failure.stdout ?? '';
          const files = output.split('\0').slice(1).filter((value, index, values) => value !== '' && !values.slice(0, index).includes(''));
          snapshot.conflict = { taskId: task.id, attemptId: attempt.attemptId, taskBaseCommit: attempt.taskBaseCommit,
            currentCommit: current, incomingCommit: checkpoint.commit, files, output: output + (failure.stderr ?? '') };
          task.status = 'conflicted'; snapshot.status = 'conflicted';
          await this.save(snapshot); return;
        }
        const tree = output.split('\0')[0].trim();
        if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error('Integration did not return a valid Git tree.');
        const date = (await execFileAsync('git', ['-C', workspacePath, 'show', '-s', '--format=%cI', snapshot.runBaseCommit])).stdout.trim();
        integratedCommit = (await execFileAsync('git', ['-C', workspacePath, 'commit-tree', tree,
          '-p', current, '-p', checkpoint.commit, '-m', 'chore(slopify): integrate task checkpoint',
          '-m', `Slopify-Run: ${snapshot.runId}`, '-m', `Slopify-Task: ${task.id}`, '-m', `Slopify-Attempt: ${attempt.attemptId}`],
        { env: { ...process.env, GIT_AUTHOR_NAME: 'Slopify', GIT_AUTHOR_EMAIL: 'slopify@localhost',
          GIT_COMMITTER_NAME: 'Slopify', GIT_COMMITTER_EMAIL: 'slopify@localhost', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })).stdout.trim();
      }
      await execFileAsync('git', ['-C', workspacePath, 'update-ref', `refs/heads/${snapshot.integrationBranch}`, integratedCommit, current]);
      snapshot.integrationCommit = integratedCommit; attempt.integratedCommit = integratedCommit;
      // Persist the private receipt before publication; completed checkpoints remain inspectable on failure.
      await this.save(snapshot);
      await this.publish(snapshot, workspacePath);
      task.status = 'succeeded';
      await this.save(snapshot);
      if (attempt.resource) {
        try { await executor.cleanup(attempt.resource); attempt.resourceState = 'removed'; }
        catch (error) { attempt.diagnostics = [...attempt.diagnostics ?? [], { code: 'cleanup_failed', message: String(error) }]; }
        await this.save(snapshot);
      }
    } catch (error) {
      task.status = 'failed';
      attempt.diagnostics = [...attempt.diagnostics ?? [], { code: 'integration_failed', message: String(error) }];
      await this.save(snapshot);
    }
  }

  private async publish(snapshot: TaskBatchSnapshot, workspacePath: string): Promise<void> {
    await execFileAsync('git', ['-C', this.repositoryPath, 'fetch', '--no-tags', workspacePath,
      `refs/heads/${snapshot.integrationBranch}:refs/heads/${snapshot.integrationBranch}`]);
  }

  async status(runId: string): Promise<TaskBatchSnapshot> {
    if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Invalid run ID.');
    const snapshot = JSON.parse(await readFile(path.join(this.storePath, runId, 'state.json'), 'utf8')) as TaskBatchSnapshot;
    if (snapshot.repositoryPath !== this.repositoryPath) throw new Error('Run belongs to another repository.');
    return snapshot;
  }
}

export type TaskAgent = 'pi' | 'codex';

export interface BatchTask {
  id: string;
  prompt: string;
  dependsOn: string[];
  agent: TaskAgent;
  source: string;
}

export interface TaskBatch {
  specFile: string;
  tasks: BatchTask[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateBatch(input: unknown): TaskBatch {
  const diagnostics: TaskBatchDiagnostic[] = [];
  const report = (code: string, path: string, message: string) => diagnostics.push({ code, path, message });
  if (!record(input)) {
    throw new TaskBatchValidationError([{ code: 'invalid_batch', path: '$', message: 'Expected a batch object.' }]);
  }
  if (!nonempty(input.specFile)) report('invalid_spec_file', 'specFile', 'Expected a nonempty spec file path.');
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    report('invalid_tasks', 'tasks', 'Expected a nonempty task list.');
    throw new TaskBatchValidationError(diagnostics);
  }
  const ids = new Set<string>();
  for (const [index, task] of input.tasks.entries()) {
    const at = `tasks[${index}]`;
    if (!record(task)) { report('invalid_task', at, 'Expected a task object.'); continue; }
    if (!nonempty(task.id)) report('invalid_id', `${at}.id`, 'Expected a nonempty task ID.');
    else if (ids.has(task.id)) report('duplicate_id', `${at}.id`, `Duplicate task ID "${task.id}".`);
    else ids.add(task.id);
    if (!nonempty(task.prompt)) report('invalid_prompt', `${at}.prompt`, 'Expected the complete nonempty task prompt.');
    if (!Array.isArray(task.dependsOn) || !task.dependsOn.every(nonempty)) {
      report('invalid_dependencies', `${at}.dependsOn`, 'Expected a list of nonempty task IDs.');
    }
    if (task.agent !== 'pi' && task.agent !== 'codex') report('invalid_agent', `${at}.agent`, 'Agent must be pi or codex.');
    if (!nonempty(task.source)) report('invalid_source', `${at}.source`, 'Expected a nonempty file or issue reference.');
  }
  for (const [index, task] of input.tasks.entries()) {
    if (!record(task) || !Array.isArray(task.dependsOn)) continue;
    for (const [dependencyIndex, dependency] of task.dependsOn.entries()) {
      if (!nonempty(dependency)) continue;
      const at = `tasks[${index}].dependsOn[${dependencyIndex}]`;
      if (dependency === task.id) report('self_dependency', at, `Task "${task.id}" depends on itself.`);
      else if (!ids.has(dependency)) report('missing_dependency', at, `Dependency "${dependency}" is absent from this batch.`);
    }
  }
  if (diagnostics.length) throw new TaskBatchValidationError(diagnostics);
  const batch = input as unknown as TaskBatch;
  const visited = new Set<string>();
  const active: string[] = [];
  const byId = new Map(batch.tasks.map((task) => [task.id, task]));
  const visit = (id: string): void => {
    const index = active.indexOf(id);
    if (index !== -1) {
      throw new TaskBatchValidationError([{
        code: 'dependency_cycle', path: 'tasks',
        message: `Dependency cycle: ${[...active.slice(index), id].join(' -> ')}.`,
      }]);
    }
    if (visited.has(id)) return;
    active.push(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    active.pop();
    visited.add(id);
  };
  for (const task of batch.tasks) visit(task.id);
  return batch;
}
