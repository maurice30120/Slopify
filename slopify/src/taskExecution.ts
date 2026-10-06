import type { TaskAgent, TaskBatchDiagnostic } from './taskBatch.js';

/** External sandbox identity is recorded as soon as it exists, before agent execution. */
export interface TaskSandboxResource {
  sandboxName: string;
  sandboxId?: string;
  inspectCommand: string[];
}

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

export interface TaskExecutionResult {
  exitCode: number;
  checkpoint?: { commit: string; bundlePath: string };
  stdoutPath: string;
  stderrPath: string;
  reportPath?: string;
  resource?: TaskSandboxResource;
  diagnostics: TaskBatchDiagnostic[];
}

export interface TaskExecutor {
  execute(request: TaskExecutionRequest): Promise<TaskExecutionResult>;
  cleanup(resource: TaskSandboxResource): Promise<void>;
}
