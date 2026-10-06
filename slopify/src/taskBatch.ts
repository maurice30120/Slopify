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
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'blocked';
  attempts: BatchTaskAttempt[];
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
}

const execFileAsync = promisify(execFile);

/** Public V2 seam: validation and durable context never enter the V1 pipeline runtime. */
export class TaskBatchService {
  readonly repositoryPath: string;
  readonly storePath: string;
  private readonly subprocessExecutor: SubprocessExecutor;

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
    const stateFile = path.join(runDirectory, 'state.json');
    await writeFile(`${stateFile}.tmp`, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    await rename(`${stateFile}.tmp`, stateFile);
    if (options.execute !== false && snapshot.tasks.length === 1) await this.executeSingle(snapshot, options.signal);
    return snapshot;
  }

  private async save(snapshot: TaskBatchSnapshot): Promise<void> {
    snapshot.updatedAt = new Date().toISOString();
    const file = path.join(this.storePath, snapshot.runId, 'state.json');
    await writeFile(file+'.tmp',JSON.stringify(snapshot,null,2),{mode:0o600});
    await rename(file+'.tmp',file);
  }

  private async executeSingle(snapshot: TaskBatchSnapshot, signal?: AbortSignal): Promise<void> {
    const runDirectory=path.join(this.storePath,snapshot.runId);
    const workspacePath=path.join(runDirectory,'integration');
    const task=snapshot.tasks[0];
    const attemptId=randomUUID();
    const resultDirectory=path.join(runDirectory,'attempts',attemptId);
    const attempt:BatchTaskAttempt={attemptId,taskBaseCommit:snapshot.runBaseCommit,status:'running'};
    task.attempts.push(attempt);task.status='running';snapshot.status='running';
    await this.save(snapshot);
    const executor=new DockerTaskExecutor({executor:this.subprocessExecutor});
    try {
      await execFileAsync('git',['clone','--no-hardlinks','--quiet','--',this.repositoryPath,workspacePath]);
      await execFileAsync('git',['-C',workspacePath,'checkout','--detach',snapshot.runBaseCommit]);
      await execFileAsync('git',['-C',workspacePath,'branch',snapshot.integrationBranch,snapshot.runBaseCommit]);
      await execFileAsync('git',['-C',this.repositoryPath,'fetch','--no-tags',workspacePath,`refs/heads/${snapshot.integrationBranch}:refs/heads/${snapshot.integrationBranch}`]);
      snapshot.integrationCommit=snapshot.runBaseCommit;
      snapshot.diagnostics.push({code:'host_changes_excluded',message:'Uncommitted user changes are excluded; the private checkout starts from '+snapshot.runBaseCommit+'.'});
      await this.save(snapshot);
      const result=await executor.execute({runId:snapshot.runId,taskId:task.id,attemptId,agent:task.agent,workspacePath,specFile:snapshot.context.specFile,prompt:task.prompt,taskBaseCommit:snapshot.runBaseCommit,runBaseCommit:snapshot.runBaseCommit,resultDirectory,signal,
        onResource:async(resource:TaskSandboxResource)=>{attempt.resource=resource;attempt.resourceState='active';await this.save(snapshot);}});
      Object.assign(attempt,result);
      attempt.resourceState=result.resource?'retained':undefined;
      if(result.exitCode!==0 || !result.checkpoint){
        task.status=signal?.aborted?'interrupted':'failed';attempt.status=task.status;snapshot.status=task.status;
        await this.save(snapshot);return;
      }
      // The bundle is persisted independently of the sandbox before branch publication.
      await execFileAsync('git',['-C',workspacePath,'fetch','--no-tags',result.checkpoint.bundlePath,result.checkpoint.commit]);
      await execFileAsync('git',['-C',workspacePath,'update-ref',`refs/heads/${snapshot.integrationBranch}`,result.checkpoint.commit,snapshot.runBaseCommit]);
      await execFileAsync('git',['-C',this.repositoryPath,'fetch','--no-tags',workspacePath,`refs/heads/${snapshot.integrationBranch}:refs/heads/${snapshot.integrationBranch}`]);
      snapshot.integrationCommit=result.checkpoint.commit;attempt.integratedCommit=result.checkpoint.commit;
      task.status='succeeded';attempt.status='succeeded';snapshot.status='succeeded';
      await this.save(snapshot);
      if(result.resource){
        try {await executor.cleanup(result.resource);attempt.resourceState='removed';}
        catch(error){attempt.diagnostics=[...attempt.diagnostics??[],{code:'cleanup_failed',message:error instanceof Error?error.message:String(error)}];}
        await this.save(snapshot);
      }
    }catch(error){
      task.status=signal?.aborted?'interrupted':'failed';attempt.status=task.status;snapshot.status=task.status;
      attempt.resourceState=attempt.resource?'retained':undefined;
      attempt.diagnostics=[...attempt.diagnostics??[],{code:'integration_failed',message:error instanceof Error?error.message:String(error)}];
      await this.save(snapshot);
    }
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
