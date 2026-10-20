import { mkdir, readFile, writeFile, rename, stat, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { createNodeSubprocessExecutor, assertWorkerPoolSize, inspectLocalProcess, inspectLocalProcessGroup, readLocalProcessIdentity, type SubprocessExecutor, type TaskDiagnostic, type TaskExecutionResult, type TaskExecutor, type TaskExecutionResource, type TaskAgent, type TaskEffort, type TaskWorkerPoolConfig, type TaskWorkerState, type DockerRunSuspension, type TaskRunRuntimeFactory, type LocalAgentRunner } from '@slopify/execution';



import { loadTaskRuntimeConfig } from './taskRuntimeConfig.js';
import { RunGitOperations } from '@slopify/git';


import { activityJournalPath, appendActivitySignal, readActivitySignals, readAllActivitySignals } from '@slopify/activity';
import type { ActivitySignal } from '@slopify/activity';
import { composeActivitySignal, type ActivityTaskCandidate } from '@slopify/activity';
import { activityTaskPhrase } from '@slopify/activity';
import { extractActivityGitSignal, type ActivityGitSnapshot } from '@slopify/activity';
import { createSystemActivityTickClock, readAttemptLogTail, type ActivityTickClock } from '@slopify/activity';

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

export type TaskBatchMode = 'sandbox' | 'local';

export function assertValidMode(mode: string | undefined): asserts mode is TaskBatchMode | undefined {
  if (mode !== undefined && mode !== 'sandbox' && mode !== 'local') {
    throw new Error(`Invalid execution mode "${mode}". Use 'sandbox' or 'local'.`);
  }
}

/** Lit le mode par défaut du projet dans .slopify/runtime.yaml ; sandbox par défaut. */
export async function resolveTaskBatchMode(repositoryPath: string, cliMode?: string): Promise<TaskBatchMode> {
  assertValidMode(cliMode);
  if (cliMode === 'sandbox' || cliMode === 'local') return cliMode;
  try {
    const config = await loadTaskRuntimeConfig(repositoryPath);
    if (config.mode === 'sandbox' || config.mode === 'local') return config.mode;
  } catch { /* Une configuration invalide est déjà refusée par la validation du lot. */ }
  return 'sandbox';
}

export interface TaskBatchServiceOptions {
  repositoryPath: string;
  storePath?: string;
  subprocessExecutor?: SubprocessExecutor;
  /** Agent local injecté : requis pour exécuter Pi en mode local ; Codex par défaut. */
  localAgentRunner?: LocalAgentRunner;
  /** Production CLI injects the concrete local/sandbox runtime adapter. */
  runtimeFactory?: TaskRunRuntimeFactory;
  /** Capacité du lot, entre une et dix tâches actives ; dix par défaut. */
  maxConcurrentTasks?: number;
  /** Reçoit une copie après chaque sauvegarde durable, pour l'avancement de la CLI. */
  onUpdate?: (snapshot: TaskBatchSnapshot) => void;
  /** Seam du Signal d'activité (ADR 0013) : reçoit chaque signal complet composé par le tick minute. */
  onActivitySignal?: (signal: ActivitySignal) => void;
  /** Intervalle du tick d'activité en millisecondes ; une minute par défaut (ADR 0013). */
  activityTickIntervalMs?: number;
  /** Horloge du tick d'activité : instant courant et attente entre deux ticks ; horloge système par défaut. */
  activityTickClock?: ActivityTickClock;
}

export interface TaskBatchRunOptions {
  baseRef?: string;
  execute?: boolean;
  signal?: AbortSignal;
  /** Mode d'exécution du lot : option CLI prioritaire, sinon configuration du projet. */
  mode?: string;
}

/** Résultat durable de la validation d'un checkpoint avant toute réutilisation. */
export interface CheckpointIntegrity {
  status: 'valid' | 'invalid' | 'incomplete';
  checkedAt: string;
  reason?: string;
  commit?: string;
  bundlePath?: string;
}

export interface BatchTaskAttempt extends Partial<TaskExecutionResult> {
  attemptId: string;
  taskBaseCommit: string;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  startedAt?: string;
  finishedAt?: string;
  resourceState?: 'active' | 'retained' | 'removed';
  integratedCommit?: string;
  /** Dernière validation d'intégrité du checkpoint de cette tentative. */
  checkpointIntegrity?: CheckpointIntegrity;
  /** Décision opérateur explicite d'écarter le checkpoint inutilisable de cette tentative (resume-task --discard-checkpoint) ; ses preuves restent conservées. */
  checkpointDiscarded?: { discardedAt: string };
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

export interface TaskBatchSnapshot {
  version: 1;
  /** Capacité figée à la création du lot ; absent dans les anciens états. */
  maxConcurrentTasks?: number;
  /** Figée à la création du lot ; absente seulement dans les anciens états persistés. */
  workerPoolConfig?: TaskWorkerPoolConfig;
  workers?: TaskWorkerState[];
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
  suspension?: DockerRunSuspension;
  resolution?: TaskBatchResolution;
  /** Mode d'exécution figé à la création du lot ; les anciens états restent sandbox. */
  mode?: TaskBatchMode;
}

/** Une exécution arrêtée alors que l'état durable était déjà disponible ; la CLI peut rendre compte de son résultat. */
export class TaskBatchExecutionError extends Error {
  constructor(readonly snapshot: TaskBatchSnapshot, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'TaskBatchExecutionError';
  }
}

const DEFAULT_MAX_CONCURRENT_TASKS = 10;
/** Intervalle du tick d'activité par défaut : une minute (ADR 0013). */
const ACTIVITY_TICK_INTERVAL_MS = 60_000;

/** Lecture d'une tentative observée par le tick : offset du log et dernier delta git du clone. */
interface ActivityAttemptReading {
  logOffset: number;
  gitSnapshot: ActivityGitSnapshot | null;
}

/** État du tick pendant une commande longue : lectures par tentative, dernier signal émis par tâche (bornage) et par tentative (repli « rien de nouveau »). */
interface ActivityTickSession {
  attempts: Map<string, ActivityAttemptReading>;
  lastSignalAtByTask: Map<string, Date>;
  lastSignalAtByAttempt: Map<string, Date>;
}

/** Seam public V2 : la validation et le contexte durable ne pénètrent jamais dans le runtime de pipeline V1. */
export class TaskBatchService {
  readonly repositoryPath: string;
  readonly storePath: string;
  private readonly subprocessExecutor: SubprocessExecutor;
  private readonly maxConcurrentTasks: number;
  private readonly runtimeFactory?: TaskRunRuntimeFactory;
  private readonly onUpdate?: TaskBatchServiceOptions['onUpdate'];
  private readonly onActivitySignal?: TaskBatchServiceOptions['onActivitySignal'];
  private readonly activityTickIntervalMs: number;
  private readonly activityClock: ActivityTickClock;
  /** Tâche en cours d'intégration, observée par le tick (phrase d'intégration). */
  private activityIntegrationTaskId?: string;
  private readonly saves = new Map<string, Promise<void>>();
  private readonly git = new RunGitOperations();

  /** Clones and integrations share a single Git lock for the integration repository. */
  private withIntegrationGitLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.git.withIntegrationLock(operation);
  }

  constructor(options: TaskBatchServiceOptions) {
    const capacity = options.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS;
    // Garde partagée avec la configuration du pool de workers : une seule autorité sur l'entier 1–10.
    assertWorkerPoolSize(capacity, 'maxConcurrentTasks');
    this.maxConcurrentTasks = capacity;
    this.runtimeFactory = options.runtimeFactory;
    this.repositoryPath = path.resolve(options.repositoryPath);
    this.onUpdate = options.onUpdate;
    this.subprocessExecutor = options.subprocessExecutor ?? createNodeSubprocessExecutor();
    this.onActivitySignal = options.onActivitySignal;
    this.activityTickIntervalMs = options.activityTickIntervalMs ?? ACTIVITY_TICK_INTERVAL_MS;
    this.activityClock = options.activityTickClock ?? createSystemActivityTickClock();
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
      runBaseCommit = (await this.git.command( ['-C', this.repositoryPath, 'rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`])).stdout.trim();
    } catch (error) {
      throw new TaskBatchValidationError([{ code: 'invalid_base', path: 'baseRef', message: `Cannot resolve the run base commit: ${error instanceof Error ? error.message : String(error)}` }]);
    }
    const missingInputFiles = await this.validateInputFiles(batch.inputFiles ?? [], runBaseCommit);
    if (missingInputFiles.length > 0) throw new TaskBatchValidationError(missingInputFiles);
    let workerPoolConfig: TaskWorkerPoolConfig;
    try { workerPoolConfig = await loadTaskRuntimeConfig(this.repositoryPath); }
    catch (error) { throw new TaskBatchValidationError([{ code: 'invalid_runtime_config', path: '.slopify/runtime.yaml',
      message: error instanceof Error ? error.message : String(error) }]); }
    // Le mode concerne tout le lot : option CLI prioritaire, puis configuration du projet, puis sandbox.
    const mode = await resolveTaskBatchMode(this.repositoryPath, options.mode);
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
      version: 1, mode, maxConcurrentTasks: Math.min(this.maxConcurrentTasks, workerPoolConfig.size), workerPoolConfig, workers: [], runId, repositoryPath: this.repositoryPath, status: 'ready', runBaseCommit,
      integrationBranch: `feature/slopify-${runId}`, createdAt: now, updatedAt: now,
      context: { specFile: frozenSpecFile, specText, batchFile: frozenBatchFile },
      tasks: [...batch.tasks.map((task) => ({ ...task, status: 'pending' as const, attempts: [] as BatchTaskAttempt[] })), finalReviewTask(batch, runBaseCommit)], diagnostics: [],
    };
    await this.save(snapshot);
    if (options.execute !== false) await this.executeSchedule(snapshot, options.signal);
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
    try {
      await current;
      try { this.onUpdate?.(JSON.parse(contents)); }
      catch { /* Un échec de reporting ne doit jamais modifier un résultat de tâche déjà persisté. */ }
    }
    finally { if (this.saves.get(snapshot.runId) === current) this.saves.delete(snapshot.runId); }
  }

  private async validateInputFiles(inputFiles: string[], baseCommit: string): Promise<TaskBatchDiagnostic[]> {
    const diagnostics: TaskBatchDiagnostic[] = [];
    for (const [index, inputFile] of inputFiles.entries()) {
      let mode: string | undefined;
      let isDirectory = false;
      try {
        const entries = (await this.git.command( [
          '--literal-pathspecs', '-C', this.repositoryPath, 'ls-tree', '-r', '-z', baseCommit, '--', inputFile,
        ])).stdout.split('\0');
        const entry = entries.find(value => {
          const separator = value.indexOf('\t');
          return separator >= 0 && value.slice(separator + 1) === inputFile;
        });
        if (entry) mode = entry.slice(0, entry.indexOf(' '));
        else isDirectory = entries.some(value => {
          const separator = value.indexOf('\t');
          return separator >= 0 && value.slice(separator + 1).startsWith(`${inputFile}/`);
        });
      } catch { /* Un chemin introuvable pour Git est diagnostiqué ci-dessous. */ }
      if (!mode && !isDirectory) {
        diagnostics.push({
          code: 'missing_input_file',
          path: `inputFiles[${index}]`,
          message: `Input file "${inputFile}" is not present in run base ${baseCommit}; commit it before launching the batch.`,
        });
      } else if (isDirectory || (mode !== '100644' && mode !== '100755')) {
        diagnostics.push({
          code: 'invalid_input_file',
          path: `inputFiles[${index}]`,
          message: `Input file "${inputFile}" must be a committed regular file in run base ${baseCommit}; symlinks, directories, and submodules are not supported.`,
        });
      }
    }
    return diagnostics;
  }

  /** The CLI owns adapter composition. This service only schedules via a contract. */
  private createExecutionRuntime(snapshot: TaskBatchSnapshot, signal?: AbortSignal) {
    if (!this.runtimeFactory) throw new Error('An execution runtime factory must be injected by the host CLI.');
    return this.runtimeFactory({
      snapshot, signal, subprocess: this.subprocessExecutor, repositoryPath: this.repositoryPath,
      saveSnapshot: () => this.save(snapshot),
    });
  }

  /** Mode enregistré à la création : les états plus anciens restent sandbox. */
  private runMode(snapshot: TaskBatchSnapshot): TaskBatchMode {
    return snapshot.mode ?? 'sandbox';
  }

  private async executeSchedule(snapshot: TaskBatchSnapshot, signal?: AbortSignal): Promise<void> {
    await this.withActivityTick(snapshot, signal, () => this.runSchedule(snapshot, signal));
  }

  private async runSchedule(snapshot: TaskBatchSnapshot, signal?: AbortSignal): Promise<void> {
    const runDirectory = path.join(this.storePath, snapshot.runId);
    const workspacePath = path.join(runDirectory, 'integration');
    const runtime = this.createExecutionRuntime(snapshot, signal);
    const executor = runtime.executor;
    signal = runtime.health.controller.signal;
    snapshot.status = 'running';
    await this.save(snapshot);
    try {
      const currentIntegrationCommit = await this.git.prepareIntegration(
        this.repositoryPath, workspacePath, snapshot.integrationBranch,
        snapshot.runBaseCommit, snapshot.integrationCommit);
      await this.publish(snapshot, workspacePath);
      snapshot.integrationCommit = currentIntegrationCommit;
      snapshot.diagnostics.push({ code: 'host_changes_excluded', message: 'Uncommitted user changes are excluded; the private checkout starts from ' + snapshot.runBaseCommit + '.' });
      await this.save(snapshot);

      const active = new Map<string, Promise<void>>();
      let integration: Promise<void> | undefined;
      let prepared = false;
      try {
        while (true) {
          this.blockDescendants(snapshot);
          if (!signal?.aborted && !snapshot.conflict) {
            const byId = new Map(snapshot.tasks.map(task => [task.id, task]));
            for (const task of snapshot.tasks) {
              if (active.size >= (snapshot.maxConcurrentTasks ?? this.maxConcurrentTasks)) break;
              if (task.status !== 'pending' || !task.dependsOn.every(id => byId.get(id)!.status === 'succeeded')) continue;
              if (!prepared) {
                await executor.prepareRun?.({ runId: snapshot.runId, workspacePath, signal });
                prepared = true;
                if (signal?.aborted || snapshot.suspension) break;
              }
              // La base appartient à la tentative : les intégrations suivantes ne la modifient jamais.
              const execution = this.executeTask(snapshot, task, snapshot.integrationCommit!, workspacePath, executor, signal)
                .finally(() => { active.delete(task.id); });
              active.set(task.id, execution);
            }
          }
          if (!integration && !snapshot.conflict && !snapshot.suspension) {
            // Les checkpoints disponibles dans ce tour sont départagés par l'ordre du manifeste.
            // Cela réutilise aussi les résultats durables d'une reprise explicite.
            const ready = snapshot.tasks.find(task => task.status === 'completed');
            if (ready) {
              // Le checkout final et les fetchs du bundle touchent le même dépôt d'intégration
              // que les clones d'exécution : une seule chaîne Git à la fois sur ce dépôt.
              integration = this.withIntegrationGitLock(async () => {
                await this.integrateTask(snapshot, ready, workspacePath, executor);
                await this.git.command( ['-C', workspacePath, 'checkout', '--detach', snapshot.integrationCommit!]);
              })
                .finally(() => { integration = undefined; });
            }
          }
          const events = [...active.values(), ...(integration ? [integration] : [])];
          if (events.length === 0) break;
          await Promise.race(events);
        }
      } finally {
        // Un conflit ferme l'admission et l'intégrateur, mais laisse les tentatives actives produire leurs preuves.
        await Promise.allSettled([...active.values(), ...(integration ? [integration] : [])]);
      }
      await this.finishExecution(snapshot, signal);
    } catch (error) {
      snapshot.status = signal?.aborted ? 'interrupted' : 'failed';
      snapshot.diagnostics.push({ code: 'integration_failed', message: error instanceof Error ? error.message : String(error) });
      await this.save(snapshot);
    } finally {
      await runtime.stopSuspendedResources();
      await runtime.close();
    }
  }

  /**
   * Tick minute du Signal d'activité (ADR 0013) : pendant toute commande longue,
   * un tick par intervalle compose le Signal des tâches actives et de la phase
   * d'intégration, le journalise dans le journal du run du store puis l'émet
   * via le seam onActivitySignal. Le tick démarre avec l'exécution, se tait
   * sans tâche active ni intégration, s'arrête à la fin ou à l'interruption
   * (interruption propagée respectée), et aucune de ses pannes ne peut jamais
   * interrompre l'exécution d'une tâche.
   */
  private async withActivityTick<T>(snapshot: TaskBatchSnapshot, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const propagate = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', propagate, { once: true });
    this.activityIntegrationTaskId = undefined;
    const session: ActivityTickSession = { attempts: new Map(), lastSignalAtByTask: new Map(), lastSignalAtByAttempt: new Map() };
    const loop = this.activityTickLoop(snapshot, session, controller.signal)
      .catch(() => {})
      .finally(() => { signal?.removeEventListener('abort', propagate); });
    try {
      return await operation();
    } finally {
      controller.abort();
      await loop;
    }
  }

  private async activityTickLoop(snapshot: TaskBatchSnapshot, session: ActivityTickSession, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.activityClock.wait(this.activityTickIntervalMs, signal);
      if (signal.aborted) return;
      try { await this.emitActivityTick(snapshot, session, signal); }
      catch { /* L'observabilité n'interrompt jamais l'exécution d'une tâche. */ }
    }
  }

  /** Un tick : compose le Signal des tâches actives, le journalise puis l'émet ; silencieux sans activité. */
  private async emitActivityTick(snapshot: TaskBatchSnapshot, session: ActivityTickSession, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const activeTasks = snapshot.tasks.filter(task => task.status === 'running');
    const integrationTaskId = this.activityIntegrationTaskId;
    if (activeTasks.length === 0 && integrationTaskId === undefined) return;
    const now = new Date(this.activityClock.now());
    const runDirectory = path.join(this.storePath, snapshot.runId);
    const candidates: ActivityTaskCandidate[] = [];
    const attemptIdByTask = new Map<string, string>();
    for (const task of activeTasks) {
      const attempt = task.attempts.at(-1);
      if (!attempt || attempt.status !== 'running') { candidates.push({ taskId: task.id, noNews: true }); continue; }
      attemptIdByTask.set(task.id, attempt.attemptId);
      // Lecture incrémentale délibérée : le seam de phrase ne voit que le contenu
      // nouveau depuis le tick précédent, pas le log entier. Écart assumé à la
      // lecture littérale de l'US 6 (« dernière ligne significative du log »),
      // cohérent avec l'US 3 (au plus une phrase par tâche et par minute) : une
      // ligne déjà narrée n'est pas réémise chaque minute comme du nouveau.
      const reading = session.attempts.get(attempt.attemptId) ?? { logOffset: 0, gitSnapshot: null };
      const tail = await readAttemptLogTail(path.join(runDirectory, 'attempts', attempt.attemptId, 'stdout.log'), reading.logOffset);
      if (tail !== undefined) reading.logOffset = tail.offset;
      const git = await extractActivityGitSignal(path.join(runDirectory, 'workspaces', attempt.attemptId), reading.gitSnapshot);
      if (git.snapshot !== null) reading.gitSnapshot = git.snapshot;
      session.attempts.set(attempt.attemptId, reading);
      const phrase = activityTaskPhrase({ taskId: task.id, log: tail?.text, git, now, lastSignalAt: session.lastSignalAtByAttempt.get(attempt.attemptId) });
      candidates.push(phrase.source === 'none'
        ? { taskId: task.id, noNews: true, lastSignalAt: session.lastSignalAtByAttempt.get(attempt.attemptId) }
        : { taskId: task.id, news: { sentence: phrase.sentence, source: phrase.source } });
    }
    const composed = composeActivitySignal({
      runId: snapshot.runId, now, tasks: candidates,
      lastSignalAtByTask: Object.fromEntries(session.lastSignalAtByTask),
      ...(integrationTaskId !== undefined
        ? { integration: { sentence: `intégration du checkpoint de la tâche ${integrationTaskId}` } }
        : {}),
    });
    if (signal.aborted) return;
    // Rien à dire : une tâche active sans nouvelles est groupée, donc un signal
    // sans tâche, sans groupe ni intégration n'apporte rien — il ne pollue pas le journal.
    if (composed.tasks.length === 0 && composed.grouped === undefined && composed.integration === undefined) return;
    for (const taskSignal of composed.tasks) {
      session.lastSignalAtByTask.set(taskSignal.taskId, now);
      const attemptId = attemptIdByTask.get(taskSignal.taskId);
      if (attemptId !== undefined) session.lastSignalAtByAttempt.set(attemptId, now);
    }
    try { await appendActivitySignal(activityJournalPath(this.storePath, snapshot.runId), composed); }
    catch { /* Le journal ne doit jamais interrompre l'exécution. */ }
    try { this.onActivitySignal?.(composed); }
    catch { /* L'émission ne doit jamais interrompre l'exécution. */ }
  }

  private async finishExecution(snapshot: TaskBatchSnapshot, signal?: AbortSignal): Promise<void> {
    this.blockDescendants(snapshot);
    snapshot.status = snapshot.conflict ? 'conflicted'
      : snapshot.suspension ? 'interrupted'
      : snapshot.tasks.every(task => task.status === 'succeeded') ? 'succeeded'
      : signal?.aborted || snapshot.tasks.some(task => task.status === 'interrupted') ? 'interrupted'
      : snapshot.tasks.some(task => task.status === 'running') ? 'running' : 'failed';
    await this.save(snapshot);
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
    integrationPath: string, executor: TaskExecutor, signal?: AbortSignal): Promise<void> {
    const attemptId = randomUUID();
    const runDirectory = path.join(this.storePath, snapshot.runId);
    const workspacePath = path.join(runDirectory, 'workspaces', attemptId);
    const resultDirectory = path.join(runDirectory, 'attempts', attemptId);
    const attempt: BatchTaskAttempt = { attemptId, taskBaseCommit, status: 'running', startedAt: new Date().toISOString() };
    task.attempts.push(attempt); task.status = 'running';
    await this.save(snapshot);
    try {
      await mkdir(path.dirname(workspacePath), { recursive: true });
      // Le clone copie le .git de l'intégration fichier par fichier : il ne doit pas
      // chevaucher une intégration, sinon un fichier transitoire du dépôt source
      // disparaît pendant la copie et la tentative échoue pour de faux.
      await this.git.clonePinned(integrationPath, workspacePath, taskBaseCommit);
      const result = await executor.execute({ runId: snapshot.runId, taskId: task.id, attemptId, agent: task.agent,
        ...(task.model ? { model: task.model } : {}), ...(task.effort ? { effort: task.effort } : {}),
        workspacePath, specFile: snapshot.context.specFile, prompt: task.prompt, taskBaseCommit,
        runBaseCommit: snapshot.runBaseCommit, resultDirectory, signal,
        onResource: async (resource: TaskExecutionResource) => {
          attempt.resource = resource; attempt.resourceState = 'active'; await this.save(snapshot);
        },
        onProcessSpawn: async identity => {
          attempt.processIdentity = identity;
          await this.save(snapshot);
        } });
      Object.assign(attempt, result);
      attempt.resourceState = result.resource ? 'retained' : undefined;
      if (result.exitCode !== 0 || !result.checkpoint || result.diagnostics.some(d => d.code !== 'codex_evidence_unavailable')) {
        task.status = signal?.aborted ? 'interrupted' : 'failed'; attempt.status = task.status;
      } else { task.status = 'completed'; attempt.status = 'succeeded'; }
    } catch (error) {
      task.status = signal?.aborted ? 'interrupted' : 'failed'; attempt.status = task.status;
      attempt.resourceState = attempt.resource ? 'retained' : undefined;
      attempt.diagnostics = [...attempt.diagnostics ?? [], { code: 'execution_failed', message: String(error) }];
    }
    attempt.finishedAt = new Date().toISOString();
    await this.save(snapshot);
  }

  /**
   * Valide l'intégrité d'un checkpoint avant réutilisation, dans le clone
   * d'intégration où les prérequis éventuels existent : métadonnées, bundle
   * verify, list-heads (le commit annoncé doit être exposé par le bundle),
   * unbundle (lecture du pack obligatoire même si l'objet est déjà connu),
   * type du commit puis ascendance de la base de la tentative. Un checkpoint
   * invalide ou incomplet n'est jamais traité comme réussi ni écrasé.
   */
  private async validateCheckpointIntegrity(snapshot: TaskBatchSnapshot, attempt: BatchTaskAttempt): Promise<CheckpointIntegrity> {
    return this.git.validateCheckpoint({
      workspacePath: path.join(this.storePath, snapshot.runId, 'integration'),
      commit: attempt.checkpoint?.commit,
      bundlePath: attempt.checkpoint?.bundlePath,
      taskBaseCommit: attempt.taskBaseCommit,
    });
  }

  /**
   * Séquence commune de garde des checkpoints durables : chaque checkpoint
   * candidat est validé, puis la reprise échoue fermé dès qu'un seul est
   * inutilisable (voir failClosedOnUnusableCheckpoints).
   */
  private async validateReusableCheckpoints(snapshot: TaskBatchSnapshot, candidates: Array<{ task: BatchTaskState; attempt: BatchTaskAttempt }>): Promise<void> {
    const failures: Array<{ task: BatchTaskState; integrity: CheckpointIntegrity }> = [];
    for (const { task, attempt } of candidates) {
      attempt.checkpointIntegrity = await this.validateCheckpointIntegrity(snapshot, attempt);
      if (attempt.checkpointIntegrity.status !== 'valid') failures.push({ task, integrity: attempt.checkpointIntegrity });
    }
    if (failures.length > 0) await this.failClosedOnUnusableCheckpoints(snapshot, failures);
  }

  /**
   * Échec fermé commun des reprises (#110) : la tâche concernée repasse échouée,
   * l'intégrité mesurée est persistée, puis l'erreur porte le snapshot durable —
   * sans jamais relancer ni écraser les preuves. La seule issue est la décision
   * explicite de l'opérateur : `tasks resume-task <task-id> --discard-checkpoint`.
   */
  private async failClosedOnUnusableCheckpoints(snapshot: TaskBatchSnapshot, failures: Array<{ task: BatchTaskState; integrity: CheckpointIntegrity }>): Promise<never> {
    for (const { task } of failures) if (task.status !== 'failed') task.status = 'failed';
    await this.save(snapshot);
    const detail = failures.map(({ task, integrity }) =>
      `Task "${task.id}" checkpoint is ${integrity.status}: ${integrity.reason}`).join(' ');
    throw new TaskBatchExecutionError(snapshot, new Error(
      `${detail} Nothing was rerun or overwritten; inspect the retained attempts, `
      + `or explicitly discard the unusable checkpoint with slopify tasks resume-task <task-id> --discard-checkpoint.`));
  }

  private async integrateTask(snapshot: TaskBatchSnapshot, task: BatchTaskState, workspacePath: string,
    executor?: TaskExecutor): Promise<void> {
    const attempt = task.attempts.at(-1)!;
    const checkpoint = attempt.checkpoint!;
    this.activityIntegrationTaskId = task.id;
    try {
      const integration = await this.git.integrate({
        workspacePath, integrationBranch: snapshot.integrationBranch,
        currentCommit: snapshot.integrationCommit!, taskBaseCommit: attempt.taskBaseCommit,
        checkpointCommit: checkpoint.commit, bundlePath: checkpoint.bundlePath,
        runBaseCommit: snapshot.runBaseCommit, runId: snapshot.runId,
        taskId: task.id, attemptId: attempt.attemptId,
      });
      if (integration.status === 'conflicted') {
        snapshot.conflict = {
          taskId: task.id, attemptId: attempt.attemptId, taskBaseCommit: attempt.taskBaseCommit,
          currentCommit: integration.currentCommit, incomingCommit: integration.incomingCommit,
          files: integration.files, output: integration.output,
        };
        task.status = 'conflicted'; snapshot.status = 'conflicted';
        await this.save(snapshot);
        return;
      }
      const integratedCommit = integration.commit;
      snapshot.integrationCommit = integratedCommit; attempt.integratedCommit = integratedCommit;
      // Persiste le reçu privé avant publication ; les checkpoints terminés restent inspectables en cas d'échec.
      await this.save(snapshot);
      await this.publish(snapshot, workspacePath);
      task.status = 'succeeded';
      await this.save(snapshot);
      if (attempt.resource && executor) {
        try { await executor.cleanup(attempt.resource); attempt.resourceState = 'removed'; }
        catch (error) { attempt.diagnostics = [...attempt.diagnostics ?? [], { code: 'cleanup_failed', message: String(error) }]; }
        await this.save(snapshot);
      }
    } catch (error) {
      task.status = 'failed';
      attempt.diagnostics = [...attempt.diagnostics ?? [], { code: 'integration_failed', message: String(error) }];
      await this.save(snapshot);
    } finally {
      this.activityIntegrationTaskId = undefined;
    }
  }

  private async publish(snapshot: TaskBatchSnapshot, workspacePath: string): Promise<void> {
    await this.git.publish(this.repositoryPath, workspacePath, snapshot.integrationBranch);
  }

  /**
   * Fenêtre de rattrapage (ADR 0013) : les dix derniers Signaux d’activité du run,
   * lus du journal du store, dans l’ordre d’émission ; vide si le journal n’existe pas.
   */
  async recentActivitySignals(runId: string): Promise<ActivitySignal[]> {
    return readActivitySignals(activityJournalPath(this.storePath, runId));
  }

  /** Lit tout le journal d’activité afin que `tasks watch` puisse rattraper chaque nouveau signal. */
  async allActivitySignals(runId: string): Promise<ActivitySignal[]> {
    return readAllActivitySignals(activityJournalPath(this.storePath, runId));
  }

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


  /** No optimistic retries when an old local agent, or any descendant, may survive. */
  private async assertLocalAttemptStopped(task: BatchTaskState): Promise<void> {
    if (task.status !== 'running' && task.status !== 'interrupted') return;
    const attempt = task.attempts.at(-1);
    if (!attempt || (attempt.status !== 'running' && attempt.status !== 'interrupted')) return;
    const identity = attempt.processIdentity;
    const own = await inspectLocalProcess(identity);
    const group = identity?.processGroupId
      ? await inspectLocalProcessGroup(identity.processGroupId) : 'unknown';
    if (own !== 'dead' || group !== 'dead') {
      throw new Error('Task "' + task.id + '" has a live local agent process or uncertain descendants (pid ' +
        (identity?.pid ?? 'unknown') + ', process=' + own + ', group=' + group +
        '). Stop and inspect the retained attempt before retrying.');
    }
  }

  /** Cross-process lock around recovery decisions and the agent start, scoped to a run. */
  private async withResumeLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Invalid run ID.');
    const lockPath = path.join(this.storePath, runId, '.resume-lock');
    let locked = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await mkdir(lockPath);
        locked = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A second atomic guard prevents two rescuers from each moving a
        // newly acquired lock when the original launcher died (TOCTOU).
        const recoveryPath = lockPath + '.recovery';
        try { await mkdir(recoveryPath); }
        catch { throw new Error('Resume lock recovery is already active or uncertain: ' + recoveryPath); }
        try {
          let holder: Awaited<ReturnType<typeof readLocalProcessIdentity>>;
          try { holder = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8')); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw new Error('Resume lock has no verifiable owner; inspect it manually: ' + lockPath);
          }
          if (await inspectLocalProcess(holder) !== 'dead') {
            throw new Error('Another launcher may still own this run; resume lock is active or uncertain: ' + lockPath);
          }
          const stale = lockPath + '.stale-' + randomUUID();
          try { await rename(lockPath, stale); }
          catch (renameError) {
            if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError;
            continue;
          }
          await rm(stale, { recursive: true, force: true });
        } finally {
          await rm(recoveryPath, { recursive: true, force: true });
        }
      }
    }
    if (!locked) throw new Error('Unable to acquire run resume lock: ' + lockPath);
    try {
      const holder = await readLocalProcessIdentity(process.pid, 'slopify resume');
      await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify(holder), { mode: 0o600 });
      return await operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  /**
   * Reprend l'ensemble du run depuis son dernier état persistant.
   * Réutilise les résultats intégrés et les checkpoints enregistrés sans les dupliquer.
   * @param runId Identifiant durable du lot.
   * @returns Le snapshot après reprise ou suspension sur Integration Conflict.
   */
  async resume(runId: string, options: { signal?: AbortSignal } = {}): Promise<TaskBatchSnapshot> {
    return this.withResumeLock(runId, () => this.resumeUnlocked(runId, options));
  }

  private async resumeUnlocked(runId: string, options: { signal?: AbortSignal } = {}): Promise<TaskBatchSnapshot> {
    const snapshot = await this.status(runId);
    if (this.runMode(snapshot) === 'local') {
      for (const task of snapshot.tasks) await this.assertLocalAttemptStopped(task);
    }
    if (snapshot.tasks.some(task => task.status === 'running')) {
      // En local, une tentative running dont le processus a disparu est obsolète : reprise autorisée.
      if (this.runMode(snapshot) === 'local') {
        for (const task of snapshot.tasks) {
          if (task.status !== 'running') continue;
          const attempt = task.attempts.at(-1);
          if (attempt) { task.status = 'interrupted'; attempt.status = 'interrupted'; }
        }
      } else {
        throw new Error('Run has running tasks. Stop the previous agents and use tasks resume-task for each interrupted task before resuming.');
      }
    }
    if (snapshot.conflict) {
      throw new TaskBatchExecutionError(snapshot, 'Run has an unresolved conflict. Validate an explicit resolution before resuming.');
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

    // Chaque checkpoint réutilisable est validé avant toute décision de reprise :
    // un checkpoint invalide ou incomplet n'est jamais traité comme réussi ni
    // écrasé ; sa tâche reste échouée, ses preuves et ses descendants bloqués
    // sont conservés, et rien n'est relancé sans décision explicite de l'opérateur.
    const reusable: Array<{ task: BatchTaskState; attempt: BatchTaskAttempt }> = [];
    for (const task of snapshot.tasks) {
      if (!['failed', 'interrupted', 'blocked', 'completed'].includes(task.status)) continue;
      const attempt = task.attempts.at(-1);
      if (!attempt?.checkpoint || attempt.exitCode !== 0) continue;
      reusable.push({ task, attempt });
    }
    await this.validateReusableCheckpoints(snapshot, reusable);
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

    await this.executeSchedule(snapshot, options.signal);

    return snapshot;
  }

  /**
   * Reprend une Tâche d'implémentation depuis un run sauvegardé en créant une tentative distincte.
   * Les intégrations déjà réussies restent inchangées.
   * @param runId Identifiant durable du lot.
   * @param taskId Identifiant de la tâche à retenter.
   * @returns Le snapshot après exécution et intégration de la tentative.
   */
  async resumeTask(runId: string, taskId: string, options: { signal?: AbortSignal; discardCheckpoint?: boolean } = {}): Promise<TaskBatchSnapshot> {
    return this.withResumeLock(runId, () => this.resumeTaskUnlocked(runId, taskId, options));
  }

  private async resumeTaskUnlocked(runId: string, taskId: string, options: { signal?: AbortSignal; discardCheckpoint?: boolean } = {}): Promise<TaskBatchSnapshot> {
    const snapshot = await this.status(runId);
    if (snapshot.conflict) throw new TaskBatchExecutionError(snapshot, 'Run has an unresolved conflict. Use tasks resolve-conflict first.');
    if (snapshot.tasks.filter(task => task.id !== taskId && task.status === 'running').length >= (snapshot.maxConcurrentTasks ?? this.maxConcurrentTasks)) {
      throw new Error('Task capacity is full. Wait for an active task before resuming a task.');
    }

    // Recherche la tâche concernée.
    const task = snapshot.tasks.find(t => t.id === taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found in run "${runId}".`);
    }

    if (this.runMode(snapshot) === 'local') await this.assertLocalAttemptStopped(task);

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

    // Une tentative durable réussie n'est jamais rejouée : son checkpoint est
    // validé puis intégré tel quel, sans lancer d'agent ni créer de tentative.
    const durableAttempt = task.attempts.at(-1);
    if (durableAttempt?.status === 'succeeded' && durableAttempt.exitCode === 0 && durableAttempt.checkpoint) {
      durableAttempt.checkpointIntegrity = await this.validateCheckpointIntegrity(snapshot, durableAttempt);
      if (durableAttempt.checkpointIntegrity.status === 'valid') {
        snapshot.status = 'running';
        await this.save(snapshot);
        await this.integrateTask(snapshot, task, workspacePath);
        await this.finishExecution(snapshot, options.signal);
        return snapshot;
      }
      if (!options.discardCheckpoint) {
        // L'état durable (tentative conservée, intégrité enregistrée) doit rester
        // rapportable par la CLI : l'échec fermé commun porte le snapshot persisté.
        await this.failClosedOnUnusableCheckpoints(snapshot, [{ task, integrity: durableAttempt.checkpointIntegrity }]);
      }
      // Échappatoire opérateur explicite (#110 / #103 US7) : le checkpoint
      // inutilisable n'est jamais écarté par un repli silencieux, seulement par
      // cette décision persistée. Ses preuves restent conservées telles quelles
      // et une nouvelle tentative identifiable est créée par le chemin pending.
      durableAttempt.checkpointDiscarded = { discardedAt: new Date().toISOString() };
      await this.save(snapshot);
    }

    // Repasse la tâche à pending pour qu'executeTask crée une nouvelle tentative.
    task.status = 'pending';

    // Met à jour le snapshot durable.
    snapshot.status = 'running';
    await this.save(snapshot);

    // Exécute la tâche ; cette opération crée une nouvelle tentative.
    const runtime = this.createExecutionRuntime(snapshot, options.signal);
    const executor = runtime.executor;
    const executionSignal = runtime.health.controller.signal;

    await this.withActivityTick(snapshot, options.signal, async () => {
      try {
        await executor.prepareRun?.({ runId: snapshot.runId, workspacePath, signal: executionSignal });
        await this.executeTask(snapshot, task, currentIntegrationCommit, workspacePath, executor, executionSignal);

        // Relit la tâche depuis le snapshot pour obtenir son état après executeTask.
        const updatedTask = snapshot.tasks.find(t => t.id === taskId)!;
        // Après l'exécution, intègre si elle a réussi (executeTask place task.status à completed en cas de succès).
        if (updatedTask.status === 'completed' && !snapshot.suspension) {
          await this.integrateTask(snapshot, updatedTask, workspacePath, executor);
        }

        await this.finishExecution(snapshot, executionSignal);
      } catch (error) {
        snapshot.status = executionSignal.aborted ? 'interrupted' : 'failed';
        snapshot.diagnostics.push({ code: 'resume_failed', message: error instanceof Error ? error.message : String(error) });
        await this.save(snapshot);
        throw new TaskBatchExecutionError(snapshot, error);
      } finally {
        await runtime.stopSuspendedResources();
        await runtime.close();
      }
    });

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
        await this.git.command( ['clone', '--no-hardlinks', '--quiet', '--', workspacePath, resolutionSandboxPath]);

        // Positionne la sandbox sur le commit d'intégration courant, celui qui porte le conflit.
        await this.git.command( ['-C', resolutionSandboxPath, 'checkout', '--detach', snapshot.integrationCommit!]);

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
      await this.executeSchedule(snapshot, options.signal);

    } catch (error) {
      snapshot.diagnostics.push({
        code: 'resolution_failed',
        message: error instanceof Error ? error.message : String(error)
      });
      snapshot.status = 'conflicted';
      await this.save(snapshot);
      throw new TaskBatchExecutionError(snapshot, error);
    }

    return snapshot;
  }

  async getConflict(runId: string): Promise<TaskBatchConflict | undefined> {
    const snapshot = await this.status(runId);
    return snapshot.conflict;
  }

  /**
   * Valide puis intègre une résolution manuelle produite dans une sandbox dédiée.
   * La résolution doit descendre de la base du conflit avant de rejoindre la branche d'intégration.
   * @param runId Identifiant durable du lot en conflit.
   * @param resolutionId Identifiant de la résolution à valider.
   * @returns Le snapshot après validation et reprise des tâches en attente.
   */
  async validateResolution(
    runId: string,
    resolutionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<TaskBatchSnapshot> {
    const snapshot = await this.status(runId);

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
      const resolutionHead = (await this.git.command( ['-C', resolution.sandboxPath, 'rev-parse', 'HEAD'])).stdout.trim();

      // Vérifie que le commit de résolution descend de la base du conflit.
      try {
        await this.git.command( ['-C', resolution.sandboxPath, 'merge-base', '--is-ancestor', snapshot.conflict!.taskBaseCommit, resolutionHead]);
      } catch (error) {
        const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
        if (failure.code !== 1) throw error;
        // merge-base --is-ancestor renvoie le code 1 lorsque le commit n'est pas un ancêtre.
        throw new Error(`Resolution commit ${resolutionHead} does not descend from conflict base ${snapshot.conflict!.taskBaseCommit}.`);
      }

      // Crée un bundle depuis la sandbox de résolution.
      const resolutionBundlePath = path.join(runDirectory, 'resolutions', resolution.resolutionId, 'resolution.bundle');
      await this.git.command( ['-C', resolution.sandboxPath, 'bundle', 'create', resolutionBundlePath, 'HEAD']);

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

      // Reprend l'exécution des tâches pour intégrer les résultats en attente.
      await this.executeSchedule(snapshot, options.signal);

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
      throw new TaskBatchExecutionError(snapshot, error);
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
  
  /**
   * Explicitly removes only the host integration branch of a successfully
   * completed run. Failed, interrupted and conflicted runs remain resumable.
   * Checkpoints, logs, workspaces and the durable run state are never deleted.
   *
   * Ported from PR #153, restricted to successes to avoid losing recovery refs.
   */
  async clean(runId: string): Promise<TaskBatchSnapshot> {
    const snapshot = await this.status(runId);
    if (snapshot.status !== 'succeeded') {
      throw new TaskBatchExecutionError(snapshot,
        'Run ' + runId + ' is ' + snapshot.status + '; only succeeded runs can have their integration branch cleaned.');
    }
    // The ref belongs to this run, not merely to whatever branch name is stored.
    const expected = `feature/slopify-${snapshot.runId}`;
    if (snapshot.integrationBranch !== expected) {
      throw new Error('Refusing to clean a noncanonical integration branch: ' + snapshot.integrationBranch);
    }
    await this.git.removeCompletedBranch(this.repositoryPath, expected, snapshot.integrationCommit);
    return snapshot;
  }

}

export type { TaskAgent, TaskEffort } from '@slopify/execution';

export interface BatchTaskDefaults {
  agent?: TaskAgent;
  /** Valeurs par défaut des tâches Codex ; Pi garde son modèle et son effort configurés. */
  model?: string;
  effort?: TaskEffort;
}

export interface BatchTask {
  id: string;
  prompt: string;
  dependsOn: string[];
  agent: TaskAgent;
  model?: string;
  effort?: TaskEffort;
  source: string;
}

export interface TaskBatch {
  specFile: string;
  /** Fichiers d'entrée locaux, suivis dans le commit de base et lus par les tâches. */
  inputFiles?: string[];
  defaults?: BatchTaskDefaults;
  tasks: BatchTask[];
}

/**
 * Étape finale du lot, alignée sur implement-spec (étape 7) : une seule revue combinée
 * de la branche d'intégration une fois tous les tickets intégrés, chaque finding
 * corrigé dans cette même tâche, puis validation complète du monorepo et commit.
 */
function finalReviewTask(batch: TaskBatch, runBaseCommit: string): BatchTaskState {
  const used = new Set(batch.tasks.map((task) => task.id));
  let id = 'final-review';
  for (let suffix = 2; used.has(id); suffix += 1) id = `final-review-${suffix}`;
  // La revue finale suit la même logique de surcharge que les autres tâches :
  // defaults du lot d'abord, repli sur la frontière du manifeste sans defaults.
  const agent = batch.defaults?.agent ?? batch.tasks[0].agent;
  const model = agent === 'codex' ? batch.defaults?.model : undefined;
  const effort = agent === 'codex' ? batch.defaults?.effort : undefined;
  return {
    id,
    agent,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    source: 'final-review',
    dependsOn: batch.tasks.map((task) => task.id),
    prompt:
      `Tous les tickets du lot sont implémentés et intégrés sur cette branche. ` +
      `Étape finale du lot : applique le skill officiel code-review au diff complet ${runBaseCommit}...HEAD (les deux axes, Standards et Spec), avec le contexte du run (spec figée et tickets d'origine). ` +
      `Corrige chaque finding dans cette même tâche, sans annuler les décisions figées de la spec. ` +
      `Valide le monorepo complet (npm run build puis npm test à la racine) sans échec, puis commite.`,
    status: 'pending',
    attempts: [],
  };
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
  let inputFiles: string[] | undefined;
  if (input.inputFiles !== undefined) {
    if (!Array.isArray(input.inputFiles)) report('invalid_input_files', 'inputFiles', 'Expected a list of repository-relative input file paths.');
    else {
      const seenInputFiles = new Set<string>();
      inputFiles = [];
      for (const [index, inputFile] of input.inputFiles.entries()) {
        const at = `inputFiles[${index}]`;
        if (!nonempty(inputFile) || !isSafeInputFilePath(inputFile)) {
          report('invalid_input_file', at, 'Expected a safe repository-relative file path without parent-directory segments.');
          continue;
        }
        const normalized = path.posix.normalize(inputFile);
        if (seenInputFiles.has(normalized)) report('duplicate_input_file', at, `Duplicate input file "${normalized}".`);
        else {
          seenInputFiles.add(normalized);
          inputFiles.push(normalized);
        }
      }
    }
  }
  let defaults: BatchTaskDefaults = {};
  if (input.defaults !== undefined) {
    if (!record(input.defaults)) report('invalid_defaults', 'defaults', 'Expected an object with optional agent, model and effort defaults.');
    else {
      const raw = input.defaults;
      if (raw.agent !== undefined && raw.agent !== 'pi' && raw.agent !== 'codex') {
        report('invalid_default_agent', 'defaults.agent', 'Agent must be pi or codex.');
      }
      if (raw.model !== undefined && !nonempty(raw.model)) {
        report('invalid_default_model', 'defaults.model', 'Expected a nonempty Codex model name.');
      }
      if (raw.effort !== undefined && !isTaskEffort(raw.effort)) {
        report('invalid_default_effort', 'defaults.effort', `Effort must be one of: ${TASK_EFFORTS.join(', ')}.`);
      }
      defaults = {
        ...(raw.agent === 'pi' || raw.agent === 'codex' ? { agent: raw.agent } : {}),
        ...(nonempty(raw.model) ? { model: raw.model } : {}),
        ...(isTaskEffort(raw.effort) ? { effort: raw.effort } : {}),
      };
    }
  }
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
    const effectiveAgent = task.agent === undefined ? defaults.agent : task.agent;
    if (effectiveAgent !== 'pi' && effectiveAgent !== 'codex') report('invalid_agent', `${at}.agent`, 'Set agent to pi or codex, either on the task or in defaults.agent.');
    if (task.model !== undefined && !nonempty(task.model)) report('invalid_model', `${at}.model`, 'Expected a nonempty Codex model name.');
    if (task.effort !== undefined && !isTaskEffort(task.effort)) {
      report('invalid_effort', `${at}.effort`, `Effort must be one of: ${TASK_EFFORTS.join(', ')}.`);
    }
    if (effectiveAgent === 'pi' && (task.model !== undefined || task.effort !== undefined)) {
      report('unsupported_pi_settings', at, 'Pi tasks use the configured Pi model and do not accept task-level model or effort overrides.');
    }
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
  // SAFETY: l'entrée a été validée ci-dessus et est nécessairement un TaskBatch (validateBatch rejette tout le reste avant).
  const batch: TaskBatch = {
    specFile: input.specFile as string,
    ...(inputFiles?.length ? { inputFiles } : {}),
    ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
    tasks: input.tasks.map((task) => {
      const raw = task as Record<string, unknown>;
      const agent = (raw.agent === undefined ? defaults.agent : raw.agent) as TaskAgent;
      const model = agent === 'codex' ? raw.model ?? defaults.model : undefined;
      const effort = agent === 'codex' ? raw.effort ?? defaults.effort : undefined;
      return {
        id: raw.id as string,
        prompt: raw.prompt as string,
        dependsOn: raw.dependsOn as string[],
        agent,
        ...(nonempty(model) ? { model } : {}),
        ...(isTaskEffort(effort) ? { effort } : {}),
        source: raw.source as string,
      };
    }),
  };
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

function isSafeInputFilePath(value: string): boolean {
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes('\\') || value.includes('\0')) return false;
  if (value.split('/').includes('..')) return false;
  const normalized = path.posix.normalize(value);
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith('../') && !normalized.endsWith('/');
}

const TASK_EFFORTS: readonly TaskEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function isTaskEffort(value: unknown): value is TaskEffort {
  return typeof value === 'string' && TASK_EFFORTS.includes(value as TaskEffort);
}
