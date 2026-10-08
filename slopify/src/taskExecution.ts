import type { TaskAgent, TaskBatchDiagnostic } from './taskBatch.js';

/** L'identité externe de la sandbox est enregistrée dès sa création, avant l'exécution de l'agent. */
export interface TaskSandboxResource {
  sandboxName: string;
  sandboxId?: string;
  inspectCommand: string[];
  diagnosticsDirectory?: string;
}

/** Contrat fonctionnel de TaskExecutionRequest dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface TaskExecutionRequest {
  runId: string;
  taskId: string;
  attemptId: string;
  agent: TaskAgent;
  workspacePath: string;
  specFile: string;
  prompt: string;
  taskBaseCommit: string;
  runBaseCommit: string;
  resultDirectory: string;
  signal?: AbortSignal;
  onResource?: (resource: TaskSandboxResource) => Promise<void>;
}

/** Contrat fonctionnel de TaskExecutionResult dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface TaskExecutionResult {
  exitCode: number;
  checkpoint?: { commit: string; bundlePath: string };
  stdoutPath: string;
  stderrPath: string;
  reportPath?: string;
  resource?: TaskSandboxResource;
  diagnostics: TaskBatchDiagnostic[];
}

/** Contrat fonctionnel de TaskExecutor dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface TaskExecutor {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  execute(request: TaskExecutionRequest): Promise<TaskExecutionResult>;
/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  cleanup(resource: TaskSandboxResource): Promise<void>;
}
