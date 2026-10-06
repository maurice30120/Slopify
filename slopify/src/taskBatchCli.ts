import * as path from 'node:path';
import { TaskBatchService, TaskBatchValidationError } from './taskBatch.js';

export const taskBatchHelp = [
  'Task batches (Pi / Codex):',
  '  slopify tasks run <batch.json> [--cwd <repository>] [--store <directory>] [--base <ref>] [--json]',
  '  slopify tasks status <run-id> [--cwd <repository>] [--store <directory>] [--json]',
  '  slopify tasks resume <run-id> [--cwd <repository>] [--store <directory>] [--json]',
  '  slopify tasks resume-task <run-id> <task-id> [--cwd <repository>] [--store <directory>] [--json]',
  '',
  'Batch paths are relative to the calling directory; specFile is relative to the batch file.',
].join('\n');


export async function runTaskBatchCli(
  argv: string[],
  output: { write(message: string): void; writeError(message: string): void },
  baseCwd = process.cwd(),
): Promise<number> {
  let json = false;
  try {
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
      output.write(taskBatchHelp);
      return 0;
    }
    const action = argv[0];
    if (action !== 'run' && action !== 'status' && action !== 'resume' && action !== 'resume-task') {
      throw new Error(`Unknown tasks command "${action}".\n${taskBatchHelp}`);
    }
    let repositoryPath = baseCwd;
    let storePath: string | undefined;
    let baseRef: string | undefined;
    const positional: string[] = [];
    for (let index = 1; index < argv.length; index += 1) {
      const value = argv[index];
      if (value === '--json') { json = true; continue; }
      if (value === '--cwd' || value === '--store' || value === '--base') {
        const next = argv[++index];
        if (!next || next.startsWith('--')) throw new Error(`${value} requires a value.`);
        if (value === '--cwd') repositoryPath = path.resolve(baseCwd, next);
        else if (value === '--store') storePath = path.resolve(baseCwd, next);
        else baseRef = next;
        continue;
      }
      if (value.startsWith('-')) throw new Error(`Unknown tasks option "${value}".`);
      positional.push(value);
    }
    const service = new TaskBatchService({ repositoryPath, storePath });
    
    if (action === 'run') {
      if (positional.length !== 1) throw new Error(taskBatchHelp);
      const snapshot = await service.run(path.resolve(baseCwd, positional[0]), { baseRef });
      output.write(json ? JSON.stringify(snapshot) : `Run ${snapshot.runId}: ${snapshot.status}\nIntegration branch: ${snapshot.integrationBranch}\n${snapshot.tasks.map((task) => `${task.id}: ${task.status} (${task.agent})`).join('\n')}`);
      return 0;
    }
    
    if (action === 'status') {
      if (positional.length !== 1) throw new Error(taskBatchHelp);
      const snapshot = await service.status(positional[0]);
      output.write(json ? JSON.stringify(snapshot) : `Run ${snapshot.runId}: ${snapshot.status}\nIntegration branch: ${snapshot.integrationBranch}\n${snapshot.tasks.map((task) => `${task.id}: ${task.status} (${task.agent})`).join('\n')}`);
      return 0;
    }
    
    if (action === 'resume') {
      if (positional.length !== 1) throw new Error(taskBatchHelp);
      const snapshot = await service.resume(positional[0]);
      output.write(json ? JSON.stringify(snapshot) : `Run ${snapshot.runId}: ${snapshot.status}\nIntegration branch: ${snapshot.integrationBranch}\n${snapshot.tasks.map((task) => `${task.id}: ${task.status} (${task.agent})`).join('\n')}`);
      return 0;
    }
    
    if (action === 'resume-task') {
      if (positional.length !== 2) throw new Error(taskBatchHelp);
      const [runId, taskId] = positional;
      const snapshot = await service.resumeTask(runId, taskId);
      output.write(json ? JSON.stringify(snapshot) : `Run ${snapshot.runId}: ${snapshot.status}\nIntegration branch: ${snapshot.integrationBranch}\n${snapshot.tasks.map((task) => `${task.id}: ${task.status} (${task.agent})`).join('\n')}`);
      return 0;
    }
    
    throw new Error(taskBatchHelp);
  } catch (error) {
    if (json && error instanceof TaskBatchValidationError) {
      output.write(JSON.stringify({ status: 'invalid', diagnostics: error.diagnostics }));
    } else {
      output.writeError(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }
}
