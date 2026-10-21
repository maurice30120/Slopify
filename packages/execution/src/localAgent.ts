import type { SubprocessExecutor } from './subprocess.js';
import type { TaskExecutionRequest } from './taskExecution.js';
import type { TaskDiagnostic } from './types.js';
import type { LocalProcessIdentity } from './localProcessIdentity.js';

/** Portable contract for injecting an agent runner in tests and CLI composition. */
export interface LocalAgentRunRequest extends TaskExecutionRequest {
  workspacePath: string;
  logged: SubprocessExecutor;
  contextPath: string;
  onProcessSpawn?: (identity: LocalProcessIdentity) => Promise<void>;
  stream: (stream: 'stdout' | 'stderr', chunk: string) => void;
}
export interface LocalAgentRunResult {
  exitCode: number;
  report: string;
  diagnostics: TaskDiagnostic[];
  processIdentity?: LocalProcessIdentity;
}
export type LocalAgentRunner = (request: LocalAgentRunRequest) => Promise<LocalAgentRunResult>;
