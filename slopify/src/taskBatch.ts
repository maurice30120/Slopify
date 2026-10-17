import { mkdir, readFile, writeFile, rename, stat, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { createNodeSubprocessExecutor, type SubprocessExecutor } from '@acp-client/sandbox';
import { DockerTaskExecutor } from './dockerTaskExecutor.js';
import type { TaskExecutionResult, TaskSandboxResource } from './taskExecution.js';
import { activityJournalPath, appendActivitySignal, readActivitySignals } from './activityJournal.js';
import type { ActivitySignal } from './activitySignal.js';
import { composeActivitySignal, type ActivityTaskCandidate } from './activitySignalComposition.js';
import { activityTaskPhrase } from './activityTaskPhrase.js';
import { extractActivityGitSignal, type ActivityGitSnapshot } from './activitySignalGit.js';
import { createSystemActivityTickClock, readAttemptLogTail, type ActivityTickClock } from './activityTick.js';

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

/** An execution stopped after durable state was available; CLI can report its outcome. */
export class TaskBatchExecutionError extends Error {
  constructor(readonly snapshot: TaskBatchSnapshot, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'TaskBatchExecutionError';
  }
}

const execFileAsync = promisify(execFile);
const WAVE_SIZE = 10;
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
  private readonly onUpdate?: TaskBatchServiceOptions['onUpdate'];
  private readonly onActivitySignal?: TaskBatchServiceOptions['onActivitySignal'];
  private readonly activityTickIntervalMs: number;
  private readonly activityClock: ActivityTickClock;
  /** Tâche en cours d'intégration de vague, observée par le tick (phrase d'intégration). */
  private activityIntegrationTaskId?: string;
  private readonly saves = new Map<string, Promise<void>>();

  constructor(options: TaskBatchServiceOptions) {
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
      tasks: [...batch.tasks.map((task) => ({ ...task, status: 'pending' as const, attempts: [] as BatchTaskAttempt[] })), finalReviewTask(batch, runBaseCommit)], diagnostics: [],
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
    try {
      await current;
      try { this.onUpdate?.(JSON.parse(contents)); }
      catch { /* A reporting failure must not change an already persisted task outcome. */ }
    }
    finally { if (this.saves.get(snapshot.runId) === current) this.saves.delete(snapshot.runId); }
  }

  private async executeWaves(snapshot: TaskBatchSnapshot, signal?: AbortSignal): Promise<void> {
    await this.withActivityTick(snapshot, signal, () => this.runWaves(snapshot, signal));
  }

  private async runWaves(snapshot: TaskBatchSnapshot, signal?: AbortSignal): Promise<void> {
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
          && task.dependsOn.every(id => byId.get(id)!.status === 'succeeded')).slice(0, WAVE_SIZE);
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
      await this.finishExecution(snapshot, signal);
    } catch (error) {
      snapshot.status = signal?.aborted ? 'interrupted' : 'failed';
      snapshot.diagnostics.push({ code: 'integration_failed', message: error instanceof Error ? error.message : String(error) });
      await this.save(snapshot);
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
        ...(task.model ? { model: task.model } : {}), ...(task.effort ? { effort: task.effort } : {}),
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
    this.activityIntegrationTaskId = task.id;
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
    } finally {
      this.activityIntegrationTaskId = undefined;
    }
  }

  private async publish(snapshot: TaskBatchSnapshot, workspacePath: string): Promise<void> {
    await execFileAsync('git', ['-C', this.repositoryPath, 'fetch', '--no-tags', workspacePath,
      `refs/heads/${snapshot.integrationBranch}:refs/heads/${snapshot.integrationBranch}`]);
  }

  /**
   * Fenêtre de rattrapage (ADR 0013) : les dix derniers Signaux d’activité du run,
   * lus du journal du store, dans l’ordre d’émission ; vide si le journal n’existe pas.
   */
  async recentActivitySignals(runId: string): Promise<ActivitySignal[]> {
    return readActivitySignals(activityJournalPath(this.storePath, runId));
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

  /**
   * Reprend l'ensemble du run depuis son dernier état persistant.
   * Réutilise les résultats intégrés et les checkpoints enregistrés sans les dupliquer.
   * @param runId Identifiant durable du lot.
   * @returns Le snapshot après reprise ou suspension sur Integration Conflict.
   */
  async resume(runId: string, options: { signal?: AbortSignal } = {}): Promise<TaskBatchSnapshot> {
    const snapshot = await this.status(runId);
    if (snapshot.tasks.some(task => task.status === 'running')) {
      throw new Error('Run has running tasks. Stop the previous agents and use tasks resume-task for each interrupted task before resuming.');
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

    await this.executeWaves(snapshot, options.signal);

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
    if (snapshot.conflict) throw new TaskBatchExecutionError(snapshot, 'Run has an unresolved conflict. Use tasks resolve-conflict first.');
    if (snapshot.tasks.filter(task => task.id !== taskId && task.status === 'running').length >= WAVE_SIZE) {
      throw new Error('Ten other tasks are still running. Wait for the current wave before resuming a task.');
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

    await this.withActivityTick(snapshot, options.signal, async () => {
      try {
        await this.executeTask(snapshot, task, currentIntegrationCommit, workspacePath, executor, options.signal);

        // Relit la tâche depuis le snapshot pour obtenir son état après executeTask.
        const updatedTask = snapshot.tasks.find(t => t.id === taskId)!;
        // Après l'exécution, intègre si elle a réussi (executeTask place task.status à completed en cas de succès).
        if (updatedTask.status === 'completed') {
          await this.integrateTask(snapshot, updatedTask, workspacePath, executor);
        }

        await this.finishExecution(snapshot, options.signal);
      } catch (error) {
        snapshot.status = options.signal?.aborted ? 'interrupted' : 'failed';
        snapshot.diagnostics.push({ code: 'resume_failed', message: error instanceof Error ? error.message : String(error) });
        await this.save(snapshot);
        throw new TaskBatchExecutionError(snapshot, error);
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
   * @returns Le snapshot après validation et reprise des vagues en attente.
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

}

export type TaskAgent = 'pi' | 'codex';
export type TaskEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface BatchTaskDefaults {
  agent?: TaskAgent;
  /** Defaults for Codex tasks; Pi keeps its configured model and effort. */
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
  return {
    id,
    agent: batch.tasks[0].agent,
    ...(batch.tasks[0].model ? { model: batch.tasks[0].model } : {}),
    ...(batch.tasks[0].effort ? { effort: batch.tasks[0].effort } : {}),
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

const TASK_EFFORTS: readonly TaskEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function isTaskEffort(value: unknown): value is TaskEffort {
  return typeof value === 'string' && TASK_EFFORTS.includes(value as TaskEffort);
}
