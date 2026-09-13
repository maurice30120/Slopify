#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { formatHelp, parseCliArgs } from './args.js';
import { CliPipelineHost, type CliPipelineBackendFactory } from './host.js';
import { formatPipelineList, runPipelineInteractive } from './run.js';
import { NodeCliTerminal } from './terminal.js';
import { createRuntimeCliBackend } from './runtimeBackend.js';
import { inspectRun, readRunLogs, formatInspection } from './inspection.js';
import { acquireCliLease } from './lease.js';

export async function main(
  backendFactory: CliPipelineBackendFactory = createRuntimeCliBackend,
  argv = process.argv.slice(2),
): Promise<number> {
  const terminal = new NodeCliTerminal();
  let host: CliPipelineHost | null = null;
  let release: (() => void) | undefined;
  const interrupt = () => { void host?.dispose(); };
  try {
    const command = parseCliArgs(argv);
    if (command.kind === 'help') {
      terminal.write(formatHelp());
      return 0;
    }
    if (command.kind === 'inspect') {
      const inspection = await inspectRun(command.cwd, command.runId);
      terminal.write(command.json ? JSON.stringify(inspection, null, 2) : formatInspection(inspection));
      return 0;
    }
    if (command.kind === 'logs') {
      const logs = await readRunLogs(command.cwd, command.runId);
      terminal.write(command.json ? JSON.stringify(logs, null, 2) : logs.events.map(event => `${event.at} ${event.nodeId ?? 'run'} ${event.type} ${event.message ?? ''}`).join('\n'));
      return 0;
    }
    if (command.kind === 'run' || command.kind === 'resume' || command.kind === 'cancel' || command.kind === 'retry') {
      release = acquireCliLease(command.cwd);
      process.once('SIGINT', interrupt);
    }

    const keepSandboxes = (command.kind === 'run' || command.kind === 'resume') && command.keepSandboxes === true;
    host = new CliPipelineHost(command.cwd, {
      terminal,
      backendFactory: (workspaceCwd, context) => backendFactory(
        workspaceCwd,
        Object.assign(context, { keepSandboxes }),
      ),
      verbose: command.verbose,
    });

    if (command.kind === 'list') {
      terminal.write(formatPipelineList(host.listPipelines(), command.json));
      return 0;
    }
    if (command.kind === 'catalog') {
      const catalog = host.catalog();
      terminal.write(command.json ? JSON.stringify(catalog, null, 2) : catalog.pipelines.map(entry => `${entry.id} — ${entry.intention}`).join('\n'));
      return 0;
    }
    if (command.kind === 'cancel' || command.kind === 'retry') {
      const result = command.kind === 'cancel' ? await host.cancel(command.runId) : await host.retry(command.runId, command.nodeId!);
      if (result.status === 'paused') host.detach(result.runId);
      terminal.write(command.json ? JSON.stringify(result, null, 2) : `${result.runId}: ${result.status}`);
      return result.status === 'failed' ? 2 : 0;
    }

    const result = await runPipelineInteractive(host, terminal, command);
    return result.status === 'completed' ? 0 : 2;
  } catch (error: unknown) {
    terminal.writeError(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    process.off('SIGINT', interrupt);
    await host?.dispose();
    release?.();
    terminal.close();
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = await main();
}
