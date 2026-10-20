import { TaskBatchService as BaseTaskBatchService, type TaskBatchServiceOptions } from '@slopify/task-batches';
import { createModeRuntime } from '@slopify/execution-sandbox';

/** Test-only composition: the same adapters the CLI injects, with fake sbx/Pi/Codex. */
export class TaskBatchService extends BaseTaskBatchService {
  constructor(options: TaskBatchServiceOptions) {
    super({ ...options, runtimeFactory: context => createModeRuntime(context, options.localAgentRunner) });
  }
}
