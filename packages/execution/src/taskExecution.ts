import type { SubprocessExecutor } from './subprocess.js';
import type { TaskAgent, TaskDiagnostic, TaskEffort } from './types.js';

/** L'identité externe de la ressource d'exécution est enregistrée dès sa création, avant l'exécution de l'agent. */
export interface TaskExecutionResource {
  sandboxName: string;
  sandboxId?: string;
  workerId?: string;
  taskContainerName?: string;
  worktreePath?: string;
  inspectCommand: string[];
  diagnosticsDirectory?: string;
}

/** Contrat fonctionnel de TaskExecutionRequest : une tentative de tâche soumise à un environnement d'exécution. */
export interface TaskExecutionRequest {
  runId: string;
  taskId: string;
  attemptId: string;
  agent: TaskAgent;
  model?: string;
  effort?: TaskEffort;
  workspacePath: string;
  specFile: string;
  prompt: string;
  taskBaseCommit: string;
  runBaseCommit: string;
  resultDirectory: string;
  signal?: AbortSignal;
  /**
   * Marque la tâche comme la revue finale combinée du lot : son exécution est
   * une seule session reviewer neuve en lecture seule (Standards/Spec délégués,
   * rapports distincts), sans session implémenteur ni correction automatique.
   * Un échec de revue remonte comme constat et échec, jamais comme succès.
   */
  finalReview?: boolean;
  onResource?: (resource: TaskExecutionResource) => Promise<void>;
  /** Persist local agent identity immediately when spawned, before awaiting its result. */
  onProcessSpawn?: (identity: NonNullable<TaskExecutionResult['processIdentity']>) => Promise<void>;
  /** Persist an uncertain start before launching a local process. */
  onProcessStarting?: () => Promise<void>;
}

/** Contrat fonctionnel de TaskExecutionResult : le verdict observable d'une tentative. */
export interface TaskExecutionResult {
  exitCode: number;
  checkpoint?: { commit: string; bundlePath: string };
  stdoutPath: string;
  stderrPath: string;
  reportPath?: string;
  resource?: TaskExecutionResource;
  diagnostics: TaskDiagnostic[];
  /** Identité du processus agent local, quand l'exécution est locale ; distinguée d'un PID réutilisé. */
  processIdentity?: { pid: number; startedAtIso: string; command: string; startTimeTicks?: number; startTimeTag?: string; observedCommand?: string; processGroupId?: number };
  /** Every local process group started by the attempt, retained for safe resume. */
  processIdentities?: Array<NonNullable<TaskExecutionResult['processIdentity']>>;
  processSpawnPending?: boolean;
}

/**
 * Contrat injectable du cycle de vie d'une tentative : préparation du run, exécution,
 * nettoyage de la ressource. Le moteur de lots ne connaît que ce contrat ; les moteurs
 * sandbox et local l'implémentent sans dépendance inverse.
 */
export interface TaskExecutor {
  /**
   * Préparation unique du lot avant la première tentative. `agents` transporte les agents du lot :
   * un lot exclusivement Pi consomme la distribution de workflows et n'exige pas le store global
   * des skills officiel ; les moteurs qui n'en dépendent pas l'ignorent.
   */
  prepareRun?(request: { runId: string; workspacePath: string; signal?: AbortSignal; agents?: string[] }): Promise<void>;
  execute(request: TaskExecutionRequest): Promise<TaskExecutionResult>;
  cleanup(resource: TaskExecutionResource): Promise<void>;
  close?(): Promise<void>;
}

/** Fabrique d'exécution injectée dans le moteur de lots : fournit l'exécuteur adapté au run. */
export type TaskExecutorFactory = (context: {
  runId: string;
  mode: 'sandbox' | 'local';
  workspacePath: string;
  subprocess: SubprocessExecutor;
  signal?: AbortSignal;
}) => TaskExecutor;
