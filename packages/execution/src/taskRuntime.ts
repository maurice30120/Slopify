import * as path from 'node:path';
import type { SubprocessExecutor } from './subprocess.js';
import type { TaskExecutor, TaskExecutionResource } from './taskExecution.js';
import type { TaskDiagnostic } from './types.js';

export interface TaskWorkerPoolConfig {
  size: number;
  mounts: string[];
  lifecycle: 'reuse' | 'recreate';
  image?: string;
}
export type TaskWorkerStatus = 'available' | 'assigned' | 'cleaning' | 'verifying' | 'retired' | 'retained';
export interface TaskWorkerState {
  workerId: string;
  sandboxName: string;
  agent: string;
  status: TaskWorkerStatus;
  taskId?: string;
  attemptId?: string;
  replacements: number;
}
export interface DockerRunSuspension {
  kind: 'docker_unavailable';
  detectedAt: string;
  failedCommand: { command: string; args: string[]; exitCode?: number; error?: string };
  healthCheck: { exitCode?: number; stdout: string; stderr: string; error?: string };
  stops: Array<{ sandboxName: string; exitCode?: number; error?: string }>;
}
export function assertWorkerPoolSize(size: number, label = 'Worker pool size'): void {
  if (!Number.isInteger(size) || size < 1 || size > 10) throw new Error(`${label} must be an integer from 1 to 10.`);
}
export function assertSharedWorkerMounts(mounts: string[], label = 'Shared worker mounts'): void {
  if (mounts.some(mount => !mount.endsWith(':ro') || !path.isAbsolute(mount.slice(0, -3)))) {
    throw new Error(`${label} must contain absolute readonly paths ending in :ro.`);
  }
}

/**
 * Runtime state visible to adapters. Implementations only touch their own
 * resource/health fields; task-batches remains owner of scheduling & persistence.
 */
export interface TaskRuntimeState {
  runId: string;
  mode?: 'sandbox' | 'local';
  repositoryPath: string;
  status: 'ready' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'conflicted';
  workerPoolConfig?: TaskWorkerPoolConfig;
  workers?: TaskWorkerState[];
  tasks: Array<{ attempts: Array<{ attemptId: string; resource?: TaskExecutionResource; integratedCommit?: string }> }>;
  diagnostics: TaskDiagnostic[];
  suspension?: DockerRunSuspension;
}
export interface TaskRunRuntime {
  executor: TaskExecutor;
  health: { controller: AbortController; execute: SubprocessExecutor };
  stopSuspendedResources: () => Promise<void>;
  close: () => Promise<void>;
}
export interface TaskRunRuntimeContext {
  snapshot: TaskRuntimeState;
  subprocess: SubprocessExecutor;
  repositoryPath: string;
  signal?: AbortSignal;
  saveSnapshot: () => Promise<void>;
}
export type TaskRunRuntimeFactory = (context: TaskRunRuntimeContext) => TaskRunRuntime;
