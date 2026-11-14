import { TaskBatchService as BaseTaskBatchService, type TaskBatchServiceOptions } from '@slopify/task-batches';
import { createModeRuntime } from '@slopify/execution-sandbox';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

let defaultRoot: string | undefined;

/**
 * Bundle de workflows minimal pour les tests : la production fournit le bundle réel
 * de la distribution (promptsPackageRoot de la CLI) ; les tests sans exigence de
 * contenu précis reçoivent cette distribution équivalente.
 */
function defaultWorkflowResourcesRoot(): string {
  if (defaultRoot) return defaultRoot;
  const root = mkdtempSync(path.join(tmpdir(), 'slopify-test-distribution-'));
  const resources = [
    'skills/engineering/implement/SKILL.md',
    'skills/engineering/tdd/SKILL.md',
    'skills/engineering/code-review/SKILL.md',
  ];
  for (const relative of resources) {
    mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
    const skill = path.basename(path.dirname(relative));
    writeFileSync(path.join(root, relative), `Content of the ${skill} workflow skill.`);
  }
  writeFileSync(path.join(root, 'inventory.json'), JSON.stringify({ roles: {
    implementer: { entry: 'skills/engineering/implement/SKILL.md', dependencies: [{ path: 'skills/engineering/tdd/SKILL.md' }] },
    reviewer: { entry: 'skills/engineering/code-review/SKILL.md', dependencies: [] },
  } }));
  process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
  defaultRoot = root;
  return root;
}

/** Test-only composition: the same adapters the CLI injects, with fake sbx/Pi/Codex. */
export class TaskBatchService extends BaseTaskBatchService {
  constructor(options: TaskBatchServiceOptions) {
    super({ ...options, runtimeFactory: context => createModeRuntime(context, options.localAgentRunner,
      options.workflowResourcesRoot ?? defaultWorkflowResourcesRoot()) });
  }
}
