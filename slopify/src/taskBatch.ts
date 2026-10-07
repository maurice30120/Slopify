import { mkdir, readFile, writeFile, rename, stat, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { createNodeSubprocessExecutor, type SubprocessExecutor } from '@acp-client/sandbox';
import { DockerTaskExecutor } from './dockerTaskExecutor.js';
import type { TaskExecutionResult, TaskSandboxResource } from './taskExecution.js';

/** Contrat fonctionnel de TaskBatchDiagnostic dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface TaskBatchDiagnostic {
  code: string;
  message: string;
  path?: string;
}

/** Composant TaskBatchValidationError qui coordonne une étape observable du cycle de vie du pipeline et en préserve les invariants. */
export class TaskBatchValidationError extends Error {
/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
  constructor(readonly diagnostics: TaskBatchDiagnostic[]) {
    super(diagnostics.map((d) => `${d.path ? `${d.path}: ` : ''}${d.message}`).join('\n'));
    this.name = 'TaskBatchValidationError';
  }
}

/** Contrat fonctionnel de TaskBatchServiceOptions dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface TaskBatchServiceOptions {
  repositoryPath: string;
  storePath?: string;
  subprocessExecutor?: SubprocessExecutor;
}

/** Contrat fonctionnel de TaskBatchRunOptions dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface TaskBatchRunOptions {
  baseRef?: string;
  execute?: boolean;
  signal?: AbortSignal;
}

/** Contrat fonctionnel de BatchTaskAttempt dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface BatchTaskAttempt extends Partial<TaskExecutionResult> {
  attemptId: string;
  taskBaseCommit: string;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  resourceState?: 'active' | 'retained' | 'removed';
  integratedCommit?: string;
}

/** Contrat fonctionnel de BatchTaskState dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface BatchTaskState extends BatchTask {
  status: 'pending' | 'running' | 'completed' | 'conflicted' | 'succeeded' | 'failed' | 'interrupted' | 'blocked';
  attempts: BatchTaskAttempt[];
  blockedBy?: string[];
}

/** Contrat fonctionnel de TaskBatchConflict dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface TaskBatchConflict {
  taskId: string;
  attemptId: string;
  taskBaseCommit: string;
  currentCommit: string;
  incomingCommit: string;
  files: string[];
  output: string;
}

/** Contrat fonctionnel de TaskBatchResolution dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface TaskBatchResolution {
  resolutionId: string;
  conflictTaskId: string;
  conflictAttemptId: string;
  sandboxName: string;
  sandboxPath: string;
  status: 'pending' | 'resolved' | 'failed' | 'validated';
  resolutionCommit?: string;
  resolutionBundlePath?: string;
  createdAt: string;
  validatedAt?: string;
}

/** Contrat fonctionnel de TaskBatchSnapshot dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
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
  resolution?: TaskBatchResolution;
}

const execFileAsync = promisify(execFile);

/** Seam public V2 : la validation et le contexte durable ne pénètrent jamais dans le runtime de pipeline V1. */
export class TaskBatchService {
  readonly repositoryPath: string;
  readonly storePath: string;
  private readonly subprocessExecutor: SubprocessExecutor;
  private readonly saves = new Map<string, Promise<void>>();

/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
  constructor(options: TaskBatchServiceOptions) {
    this.repositoryPath = path.resolve(options.repositoryPath);
    this.subprocessExecutor = options.subprocessExecutor ?? createNodeSubprocessExecutor();
    this.storePath = path.resolve(options.storePath ?? process.env.SLOPIFY_TASK_STORE ?? path.join(
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
      homedir(), '.local', 'share', 'slopify', 'task-runs',
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
      createHash('sha256').update(this.repositoryPath).digest('hex').slice(0, 16),
    ));
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private async executeWaves(snapshot: TaskBatchSnapshot, signal?: AbortSignal): Promise<void> {
    const runDirectory = path.join(this.storePath, snapshot.runId);
    const workspacePath = path.join(runDirectory, 'integration');
    const executor = new DockerTaskExecutor({ executor: this.subprocessExecutor });
    snapshot.status = 'running';
    await this.save(snapshot);
    try {
      // Vérifie si le workspace existe déjà (par exemple après un run précédent ou une reprise).
      let workspaceExists = false;
      try {
        await stat(workspacePath);
        workspaceExists = true;
      } catch {
        workspaceExists = false;
      }
      
      if (!workspaceExists) {
        await execFileAsync('git', ['clone', '--no-hardlinks', '--quiet', '--', this.repositoryPath, workspacePath]);
      }
      // Vérifie si la branche existe avant de tenter de la créer.
      const branchResult = await execFileAsync('git', ['-C', workspacePath, 'branch', '--list', snapshot.integrationBranch]);
      const currentIntegrationCommit = branchResult.stdout.trim()
        ? (await execFileAsync('git', ['-C', workspacePath, 'rev-parse', snapshot.integrationBranch])).stdout.trim()
        : snapshot.integrationCommit ?? snapshot.runBaseCommit;
      await execFileAsync('git', ['-C', workspacePath, 'checkout', '--detach', currentIntegrationCommit]);
      if (!branchResult.stdout.trim()) {
        await execFileAsync('git', ['-C', workspacePath, 'branch', snapshot.integrationBranch, currentIntegrationCommit]);
      }
      await this.publish(snapshot, workspacePath);
      snapshot.integrationCommit = currentIntegrationCommit;
      snapshot.diagnostics.push({ code: 'host_changes_excluded', message: 'Uncommitted user changes are excluded; the private checkout starts from ' + snapshot.runBaseCommit + '.' });
      await this.save(snapshot);

      // Un checkpoint peut être durable avant l'enregistrement de son intégration. Le réutiliser
      // lors d'une reprise explicite évite de réexécuter l'agent.
      for (const task of snapshot.tasks) {
        if (task.status !== 'completed') continue;
        await this.integrateTask(snapshot, task, workspacePath, executor);
        if (snapshot.conflict) return;
      }

      while (!signal?.aborted) {
        this.blockDescendants(snapshot);
        const byId = new Map(snapshot.tasks.map(task => [task.id, task]));
        const wave = snapshot.tasks.filter(task => task.status === 'pending'
          && task.dependsOn.every(id => byId.get(id)!.status === 'succeeded'));
        if (wave.length === 0) break;
        const taskBaseCommit = snapshot.integrationCommit!;
        // Chaque tentative possède son clone et ses refs de checkpoint. Les nœuds frères ne partagent que leur base figée.
        await Promise.all(wave.map(task => this.executeTask(snapshot, task, taskBaseCommit, workspacePath, executor, signal)));
        // L'ordre des déclarations reste stable même si les agents externes terminent dans un ordre différent.
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private async integrateTask(snapshot: TaskBatchSnapshot, task: BatchTaskState, workspacePath: string,
    executor: DockerTaskExecutor): Promise<void> {
    const attempt = task.attempts.at(-1)!;
    const checkpoint = attempt.checkpoint!;
    try {
      await execFileAsync('git', ['-C', workspacePath, 'fetch', '--no-tags', checkpoint.bundlePath, checkpoint.commit]);
      await execFileAsync('git', ['-C', workspacePath, 'merge-base', '--is-ancestor', attempt.taskBaseCommit, checkpoint.commit]);
      const current = snapshot.integrationCommit!;
      const alreadyIntegrated = await execFileAsync('git', ['-C', workspacePath, 'merge-base', '--is-ancestor', checkpoint.commit, current])
        .then(() => true, error => { if (error.code === 1) return false; throw error; });
      let integratedCommit = alreadyIntegrated ? current : checkpoint.commit;
      if (!alreadyIntegrated && current !== attempt.taskBaseCommit) {
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
      // Persiste le reçu privé avant publication ; les checkpoints terminés restent inspectables en cas d'échec.
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private async publish(snapshot: TaskBatchSnapshot, workspacePath: string): Promise<void> {
    await execFileAsync('git', ['-C', this.repositoryPath, 'fetch', '--no-tags', workspacePath,
      `refs/heads/${snapshot.integrationBranch}:refs/heads/${snapshot.integrationBranch}`]);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async status(runId: string): Promise<TaskBatchSnapshot> {
    if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Invalid run ID.');
    const file = path.join(this.storePath, runId, 'state.json');
    try {
      const snapshot = JSON.parse(await readFile(file, 'utf8')) as TaskBatchSnapshot;
      if (snapshot.repositoryPath !== this.repositoryPath) throw new Error('Run belongs to another repository.');
      return snapshot;
    } catch (error) {
      throw new Error(`Cannot read state file ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Reprend l'ensemble du run depuis son dernier état persistant.
   * Réutilise les résultats intégrés et les checkpoints enregistrés sans les dupliquer.
   * @param runId Identifiant durable du lot.
   * @returns Le snapshot après reprise ou suspension sur Integration Conflict.
   */
  async resume(runId: string, options: { signal?: AbortSignal } = {}): Promise<TaskBatchSnapshot> {
    const snapshot = await this.status(runId);
    if (snapshot.conflict) {
      throw new Error('Run has an unresolved conflict. Validate an explicit resolution before resuming.');
    }

    // Vérifie qu'une branche d'intégration est disponible.
    if (!snapshot.integrationBranch) {
      throw new Error('Run has no integration branch.');
    }

    const runDirectory = path.join(this.storePath, runId);
    const workspacePath = path.join(runDirectory, 'integration');

    // Vérifie que le workspace d'intégration existe.
    try {
      await stat(workspacePath);
    } catch {
      throw new Error('Integration workspace not found. Cannot resume without integration state.');
    }

    // Vérifie l'existence des fichiers de contexte figés (spécification et lot).
    try {
      await stat(snapshot.context.specFile);
      await stat(snapshot.context.batchFile);
    } catch {
      throw new Error('Frozen context files (spec or batch) not found. Cannot resume without frozen context.');
    }

    // Réinitialise les tâches échouées ou interrompues à pending pour autoriser leur réexécution.
    for (const task of snapshot.tasks) {
      if (task.status === 'failed' || task.status === 'interrupted' || task.status === 'blocked') {
        const attempt = task.attempts.at(-1);
        task.status = attempt?.checkpoint && attempt.exitCode === 0 ? 'completed' : 'pending';
        delete task.blockedBy;
      }
    }

    // Met à jour l'état vers running.
    snapshot.status = 'running';
    await this.save(snapshot);

    // Reprend l'exécution à partir de l'état persistant.
    try {
      await this.executeWaves(snapshot, options.signal);
    } catch (error) {
      // executeWaves persiste déjà l'état.
      throw error;
    }

    return snapshot;
  }

  /**
   * Reprend une Tâche d'implémentation depuis un run sauvegardé en créant une tentative distincte.
   * Les intégrations déjà réussies restent inchangées.
   * @param runId Identifiant durable du lot.
   * @param taskId Identifiant de la tâche à retenter.
   * @returns Le snapshot après exécution et intégration de la tentative.
   */
  async resumeTask(runId: string, taskId: string, options: { signal?: AbortSignal } = {}): Promise<TaskBatchSnapshot> {
    const snapshot = await this.status(runId);

    // Vérifie que le run appartient à ce dépôt.
    if (snapshot.repositoryPath !== this.repositoryPath) {
      throw new Error('Run belongs to another repository.');
    }

    // Recherche la tâche concernée.
    const task = snapshot.tasks.find(t => t.id === taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found in run "${runId}".`);
    }

    // Autorise la reprise uniquement pour une tâche échouée, interrompue ou en cours devenue obsolète.
    // Une tâche en cours dont la sandbox est arrêtée ou supprimée est considérée comme obsolète et reprenable.
    if (task.status !== 'failed' && task.status !== 'interrupted' && task.status !== 'running') {
      throw new Error(`Task "${taskId}" has status "${task.status}" and cannot be resumed. Only failed, interrupted, or running tasks can be resumed.`);
    }

    // Vérifie qu'une branche d'intégration est disponible.
    if (!snapshot.integrationBranch) {
      throw new Error('Run has no integration branch.');
    }

    const runDirectory = path.join(this.storePath, runId);
    const workspacePath = path.join(runDirectory, 'integration');

    // Vérifie que le workspace d'intégration existe.
    try {
      await stat(workspacePath);
    } catch {
      throw new Error('Integration workspace not found. Cannot resume without integration state.');
    }

    // Vérifie l'existence des fichiers de contexte figés (spécification et lot).
    try {
      await stat(snapshot.context.specFile);
      await stat(snapshot.context.batchFile);
    } catch {
      throw new Error('Frozen context files (spec or batch) not found. Cannot resume without frozen context.');
    }

    // Récupère le commit d'intégration courant, base de la nouvelle tentative.
    const currentIntegrationCommit = snapshot.integrationCommit ?? snapshot.runBaseCommit;

    // Vérifie que toutes les dépendances de la tâche ont réussi, condition d'une reprise isolée.
    const byId = new Map(snapshot.tasks.map(t => [t.id, t]));
    const blockedBy = task.dependsOn.filter(id => byId.get(id)?.status !== 'succeeded');
    if (blockedBy.length > 0) {
      throw new Error(`Task "${taskId}" cannot be resumed: dependencies ${blockedBy.join(', ')} are not succeeded.`);
    }

    // Repasse la tâche à pending pour qu'executeTask crée une nouvelle tentative.
    task.status = 'pending';

    // Met à jour le snapshot durable.
    snapshot.status = 'running';
    await this.save(snapshot);

    // Exécute la tâche ; cette opération crée une nouvelle tentative.
    const executor = new DockerTaskExecutor({ executor: this.subprocessExecutor });

    try {
      await this.executeTask(snapshot, task, currentIntegrationCommit, workspacePath, executor, options.signal);

      // Relit la tâche depuis le snapshot pour obtenir son état après executeTask.
      const updatedTask = snapshot.tasks.find(t => t.id === taskId)!;
      // Après l'exécution, intègre si elle a réussi (executeTask place task.status à completed en cas de succès).
      if (updatedTask.status === 'completed') {
        await this.integrateTask(snapshot, updatedTask, workspacePath, executor);
      }

      await this.save(snapshot);
    } catch (error) {
      snapshot.status = options.signal?.aborted ? 'interrupted' : 'failed';
      snapshot.diagnostics.push({ code: 'resume_failed', message: error instanceof Error ? error.message : String(error) });
      await this.save(snapshot);
      throw error;
    }

    return snapshot;
  }

  /**
   * Résout explicitement un Integration Conflict avec la stratégie choisie par l'utilisateur.
   * Une résolution manuelle reste dans une sandbox dédiée jusqu'à sa validation.
   * @param runId Identifiant durable du lot en conflit.
   * @param options Stratégie `use-current`, `use-incoming` ou `manual`.
   * @returns Le snapshot après résolution ou suspension pour intervention manuelle.
   */
  async resolveConflict(
    runId: string,
    options: {
      resolutionStrategy?: 'use-current' | 'use-incoming' | 'manual';
      signal?: AbortSignal;
    } = {},
  ): Promise<TaskBatchSnapshot> {
    const snapshot = await this.status(runId);

    // Vérifie que le run appartient à ce dépôt.
    if (snapshot.repositoryPath !== this.repositoryPath) {
      throw new Error('Run belongs to another repository.');
    }

    // Vérifie qu'un conflit est à résoudre.
    if (!snapshot.conflict) {
      throw new Error('No conflict to resolve. Run is not in conflicted state.');
    }

    // Vérifie que le workspace d'intégration existe.
    const runDirectory = path.join(this.storePath, runId);
    const workspacePath = path.join(runDirectory, 'integration');

    try {
      await stat(workspacePath);
    } catch {
      throw new Error('Integration workspace not found. Cannot resolve conflict without integration state.');
    }

    const conflict = snapshot.conflict;

    try {
      // Applique la résolution selon la stratégie choisie.
      let resolutionCommit: string;

      if (options.resolutionStrategy === 'use-current') {
        // Conserve l'état courant et rejette les changements entrants.
        resolutionCommit = snapshot.integrationCommit!;

      } else if (options.resolutionStrategy === 'use-incoming') {
        // Accepte les changements entrants.
        resolutionCommit = conflict.incomingCommit;

      } else if (options.resolutionStrategy === 'manual' || !options.resolutionStrategy) {
        // Résolution manuelle : crée une sandbox dédiée depuis le contexte du conflit.
        const resolutionId = randomUUID();
        const sandboxName = `slopify-resolution-${runId}-${conflict.attemptId}-${resolutionId}`;
        const resolutionSandboxPath = path.join(this.storePath, runId, 'resolutions', sandboxName);
        const resolutionResultDir = path.join(this.storePath, runId, 'resolutions', resolutionId);

        await mkdir(path.dirname(resolutionSandboxPath), { recursive: true });
        await mkdir(resolutionResultDir, { recursive: true });

        // Clone le workspace d'intégration vers la sandbox de résolution.
        await execFileAsync('git', ['clone', '--no-hardlinks', '--quiet', '--', workspacePath, resolutionSandboxPath]);

        // Positionne la sandbox sur le commit d'intégration courant, celui qui porte le conflit.
        await execFileAsync('git', ['-C', resolutionSandboxPath, 'checkout', '--detach', snapshot.integrationCommit!]);

        // Crée l'enregistrement de résolution.
        const resolution: TaskBatchResolution = {
          resolutionId,
          conflictTaskId: conflict.taskId,
          conflictAttemptId: conflict.attemptId,
          sandboxName,
          sandboxPath: resolutionSandboxPath,
          status: 'pending',
          createdAt: new Date().toISOString(),
        };

        snapshot.resolution = resolution;
        await this.save(snapshot);

        // Retourne immédiatement : la résolution manuelle exige le travail de l'utilisateur dans la sandbox.
        return snapshot;

      } else {
        throw new Error(`Invalid resolution strategy: ${options.resolutionStrategy}. Use 'use-current', 'use-incoming', or 'manual'.`);
      }

      // La résolution est validée ; intègre maintenant les résultats en attente.
      snapshot.conflict = undefined;
      snapshot.status = 'running';

      // Recherche la tâche en conflit.
      const conflictedTask = snapshot.tasks.find(t => t.id === conflict.taskId);
      if (conflictedTask) {
        if (options.resolutionStrategy === 'use-incoming') {
          // Avec use-incoming, marque la tâche completed pour permettre son intégration.
          conflictedTask.status = 'completed';
          const attempt = conflictedTask.attempts.find(a => a.attemptId === conflict.attemptId);
          if (attempt) {
            attempt.checkpoint = {
              commit: resolutionCommit,
              bundlePath: attempt.checkpoint?.bundlePath ?? '',
            };
          }
        } else {
          // Avec use-current, marque la tâche failed : ses changements sont rejetés.
          conflictedTask.status = 'failed';
        }
      }

      await this.save(snapshot);
      await this.executeWaves(snapshot, options.signal);

    } catch (error) {
      snapshot.diagnostics.push({
        code: 'resolution_failed',
        message: error instanceof Error ? error.message : String(error)
      });
      snapshot.status = 'conflicted';
      await this.save(snapshot);
      throw error;
    }

    return snapshot;
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async getConflict(runId: string): Promise<TaskBatchConflict | undefined> {
    const snapshot = await this.status(runId);
    return snapshot.conflict;
  }

  /**
   * Valide puis intègre une résolution manuelle produite dans une sandbox dédiée.
   * La résolution doit descendre de la base du conflit avant de rejoindre la branche d'intégration.
   * @param runId Identifiant durable du lot en conflit.
   * @param resolutionId Identifiant de la résolution à valider.
   * @returns Le snapshot après validation et reprise des vagues en attente.
   */
  async validateResolution(
    runId: string,
    resolutionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<TaskBatchSnapshot> {
    const snapshot = await this.status(runId);

    // Vérifie que le run appartient à ce dépôt.
    if (snapshot.repositoryPath !== this.repositoryPath) {
      throw new Error('Run belongs to another repository.');
    }

    // Vérifie qu'une résolution est disponible pour validation.
    if (!snapshot.resolution) {
      throw new Error('No resolution to validate. Run has no pending resolution.');
    }

    if (snapshot.resolution.resolutionId !== resolutionId) {
      throw new Error(`Resolution ${resolutionId} does not match the pending resolution ${snapshot.resolution.resolutionId}.`);
    }

    if (snapshot.resolution.status !== 'pending') {
      throw new Error(`Resolution ${resolutionId} is not in pending state (current: ${snapshot.resolution.status}).`);
    }

    const resolution = snapshot.resolution;
    const runDirectory = path.join(this.storePath, runId);
    const workspacePath = path.join(runDirectory, 'integration');

    try {
      await stat(workspacePath);
    } catch {
      throw new Error('Integration workspace not found. Cannot validate resolution without integration state.');
    }

    try {
      // Vérifie que la sandbox de résolution existe.
      try {
        await stat(resolution.sandboxPath);
      } catch {
        throw new Error(`Resolution sandbox ${resolution.sandboxPath} not found.`);
      }

      // Récupère le HEAD courant de la sandbox de résolution.
      const resolutionHead = (await execFileAsync('git', ['-C', resolution.sandboxPath, 'rev-parse', 'HEAD'])).stdout.trim();

      // Vérifie que le commit de résolution descend de la base du conflit.
      try {
        await execFileAsync('git', ['-C', resolution.sandboxPath, 'merge-base', '--is-ancestor', snapshot.conflict!.taskBaseCommit, resolutionHead]);
      } catch (error) {
        const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
        if (failure.code !== 1) throw error;
        // merge-base --is-ancestor renvoie le code 1 lorsque le commit n'est pas un ancêtre.
        throw new Error(`Resolution commit ${resolutionHead} does not descend from conflict base ${snapshot.conflict!.taskBaseCommit}.`);
      }

      // Crée un bundle depuis la sandbox de résolution.
      const resolutionBundlePath = path.join(runDirectory, 'resolutions', resolution.resolutionId, 'resolution.bundle');
      await execFileAsync('git', ['-C', resolution.sandboxPath, 'bundle', 'create', resolutionBundlePath, 'HEAD']);

      // Met à jour l'enregistrement de résolution.
      resolution.status = 'validated';
      resolution.resolutionCommit = resolutionHead;
      resolution.resolutionBundlePath = resolutionBundlePath;
      resolution.validatedAt = new Date().toISOString();

      // Efface le conflit et marque la résolution comme validée.
      snapshot.conflict = undefined;
      snapshot.status = 'running';

      // Recherche la tâche en conflit et lui associe la résolution.
      const conflictedTask = snapshot.tasks.find(t => t.id === resolution.conflictTaskId);
      if (conflictedTask) {
        conflictedTask.status = 'completed';
        const attempt = conflictedTask.attempts.find(a => a.attemptId === resolution.conflictAttemptId);
        if (attempt) {
          attempt.checkpoint = {
            commit: resolutionHead,
            bundlePath: resolutionBundlePath,
          };
        }
      }

      await this.save(snapshot);

      // Reprend l'exécution des vagues pour intégrer les résultats en attente.
      await this.executeWaves(snapshot, options.signal);

      // Nettoie la sandbox de résolution après l'intégration réussie.
      try {
        await rm(resolution.sandboxPath, { recursive: true, force: true });
      } catch (error) {
        snapshot.diagnostics.push({ code: 'resolution_cleanup_failed', message: String(error) });
        await this.save(snapshot);
      }

    } catch (error) {
      // La validation a échoué ; met à jour l'état de la résolution.
      snapshot.resolution.status = 'failed';
      snapshot.diagnostics.push({
        code: 'resolution_validation_failed',
        message: error instanceof Error ? error.message : String(error)
      });
      snapshot.status = 'conflicted';
      await this.save(snapshot);
      throw error;
    }

    return snapshot;
  }

  /**
   * Récupère les détails de résolution d'un run.
   */
  async getResolution(runId: string): Promise<TaskBatchResolution | undefined> {
    const snapshot = await this.status(runId);
    return snapshot.resolution;
  }

}

/** Type métier TaskAgent utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type TaskAgent = 'pi' | 'codex';

/** Contrat fonctionnel de BatchTask dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface BatchTask {
  id: string;
  prompt: string;
  dependsOn: string[];
  agent: TaskAgent;
  source: string;
}

/** Contrat fonctionnel de TaskBatch dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface TaskBatch {
  specFile: string;
  tasks: BatchTask[];
}

/** Point d'entrée record du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Point d'entrée nonempty du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Point d'entrée validateBatch du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function validateBatch(input: unknown): TaskBatch {
  const diagnostics: TaskBatchDiagnostic[] = [];
  const report = (code: string, path: string, message: string) => diagnostics.push({ code, path, message });
  if (!record(input)) {
    throw new TaskBatchValidationError([{ code: 'invalid_batch', path: '$', message: 'Expected a batch object.' }]);
  }
  if (!nonempty(input.specFile)) report('invalid_spec_file', 'specFile', 'Expected a nonempty spec file path.');
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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
  // SÉCURITÉ : l'entrée a été validée ci-dessus et est nécessairement un TaskBatch.
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
