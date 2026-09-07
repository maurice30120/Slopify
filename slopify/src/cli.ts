#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatHelp, parseCliArgs } from './args.js';
import { CliPipelineHost, type CliPipelineBackendFactory } from './host.js';
import { formatPipelineList, runPipelineInteractive } from './run.js';
import { NodeCliTerminal } from './terminal.js';
import { createRuntimeCliBackend } from './runtimeBackend.js';

export async function main(
  backendFactory: CliPipelineBackendFactory = createRuntimeCliBackend,
  argv = process.argv.slice(2),
): Promise<number> {
  const terminal = new NodeCliTerminal();
  let host: CliPipelineHost | null = null;
  try {
    const command = parseCliArgs(argv);
    if (command.kind === 'help') {
      terminal.write(formatHelp());
      return 0;
    }

    const keepSandboxes = (command.kind === 'run' || command.kind === 'resume') && command.keepSandboxes === true;
    host = new CliPipelineHost(command.cwd, {
      terminal,
      backendFactory: (workspaceCwd, context) => backendFactory(
        workspaceCwd,
        Object.assign(context, { keepSandboxes }),
      ),
      logLevel: command.logLevel,
    });

    if (command.kind === 'list') {
      terminal.write(formatPipelineList(host.listPipelines(), command.json));
      return 0;
    }

    const result = await runPipelineInteractive(host, terminal, command);
    return result.status === 'completed' ? 0 : 2;
  } catch (error: unknown) {
    terminal.writeError(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await host?.dispose();
    terminal.close();
  }
}

const entryPoint = process.argv[1];
if (entryPoint) {
  try {
    if (realpathSync(entryPoint) === fileURLToPath(import.meta.url)) {
      process.exitCode = await main();
    }
  } catch {
    // entry point does not exist or cannot be resolved; do not run
  }
}
