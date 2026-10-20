import { DockerTaskExecutor } from './dockerTaskExecutor.js';
import { DockerRunHealth } from './dockerRunHealth.js';
import { LocalTaskExecutor, type LocalAgentRunner } from '@slopify/execution-local';
import type { TaskRunRuntime, TaskRunRuntimeContext } from '@slopify/execution';

/**
 * Concrete adapter composition. The CLI selects this factory and task-batches
 * receives only a runtime contract, never importing Docker or local executors.
 * Tests may inject a fake subprocess or a local agent runner here.
 */
export function createModeRuntime(context: TaskRunRuntimeContext, localRunner?: LocalAgentRunner): TaskRunRuntime {
  const { snapshot, subprocess, repositoryPath, signal, saveSnapshot } = context;
  delete snapshot.suspension;
  if ((snapshot.mode ?? 'sandbox') === 'local') {
    const executor = new LocalTaskExecutor({ executor: subprocess, ...(localRunner ? { agentRunner: localRunner } : {}) });
    const controller = new AbortController();
    const propagate = () => controller.abort(signal?.reason);
    if (signal?.aborted) propagate();
    else signal?.addEventListener('abort', propagate, { once: true });
    const health = { controller, execute: subprocess };
    const close = async () => {
      try { await executor.close(); }
      finally { signal?.removeEventListener('abort', propagate); }
    };
    return { executor, health, stopSuspendedResources: async () => {}, close };
  }
  const previous = new Set(snapshot.tasks.flatMap(task => task.attempts.map(attempt => attempt.attemptId)));
  const stopped = new Set<string>();
  const stopSuspendedResources = async () => {
    if (!snapshot.suspension) return;
    const suspension = snapshot.suspension;
    const resources = snapshot.tasks.flatMap(task => task.attempts)
      .filter(attempt => !previous.has(attempt.attemptId) && attempt.resource && !attempt.integratedCommit)
      .map(attempt => attempt.resource!);
    await Promise.all(resources.map(async resource => {
      if (stopped.has(resource.sandboxName)) return;
      stopped.add(resource.sandboxName);
      try {
        const result = await subprocess({ command: 'sbx', args: ['stop', resource.sandboxName],
          cwd: resource.diagnosticsDirectory ?? repositoryPath, stdin: 'ignore',
          signal: AbortSignal.timeout(10000) });
        suspension.stops.push({ sandboxName: resource.sandboxName, exitCode: result.exitCode,
          ...(result.exitCode ? { error: result.stderr || result.stdout } : {}) });
      } catch (error) {
        suspension.stops.push({ sandboxName: resource.sandboxName, error: String(error) });
      }
    }));
    await saveSnapshot();
  };
  const health = new DockerRunHealth(subprocess, async suspension => {
    snapshot.suspension = suspension;
    snapshot.status = 'interrupted';
    snapshot.diagnostics.push({ code: 'docker_unavailable',
      message: 'Shared Docker control failed; admission stopped, cancellation and sandbox stops requested, resources retained.' });
    await saveSnapshot();
    await stopSuspendedResources();
  }, signal);
  const executor = new DockerTaskExecutor({
    executor: health.execute,
    ...(snapshot.workerPoolConfig ? { pool: snapshot.workerPoolConfig } : {}),
    onWorkers: async states => {
      const workers = new Map((snapshot.workers ?? []).map(worker => [worker.workerId, worker]));
      for (const worker of states) workers.set(worker.workerId, worker);
      snapshot.workers = [...workers.values()];
      await saveSnapshot();
    },
  });
  const close = async () => {
    try { await executor.close(); }
    catch (error) {
      snapshot.diagnostics.push({ code: 'worker_shutdown_failed', message: String(error) });
      await saveSnapshot();
    } finally { health.close(); }
  };
  return { executor, health, stopSuspendedResources, close };
}
