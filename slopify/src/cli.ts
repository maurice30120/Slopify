#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from 'node:url';
import { NodeCliTerminal } from './terminal.js';
import { runTaskBatchCli, taskBatchHelp } from './taskBatchCli.js';
import { initHelp, runInitCli } from './initCli.js';

const generalHelp = `Slopify V2\n\n${initHelp}\n\n${taskBatchHelp}`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const terminal = new NodeCliTerminal();
  try {
    if (argv[0] === 'tasks') return await runTaskBatchCli(argv.slice(1), terminal);
    if (argv[0] === 'init') return await runInitCli(argv.slice(1), terminal, process.cwd(), {
      packageRoot: fileURLToPath(new URL('../..', import.meta.url)),
    });
    if (['list', 'run', 'resume'].includes(argv[0])) {
      throw new Error(`Legacy command "${argv[0]}" has been removed. Use slopify tasks run <batch.json>, slopify tasks status <run-id> or slopify tasks resume <run-id>. See slopify tasks --help.`);
    }
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
      terminal.write(generalHelp);
      return 0;
    }
    throw new Error(`Unknown command "${argv[0]}".\n\n${generalHelp}`);
  } catch (error: unknown) {
    terminal.writeError(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    terminal.close();
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = await main();
}
