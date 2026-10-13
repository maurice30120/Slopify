import { createNodeSubprocessExecutor, type SubprocessExecutor } from '@acp-client/sandbox';
import type { CliTerminal } from './terminal.js';
import { parseInitArgs, type InitHost } from './initArgs.js';
import { InitService, type InitResult } from './initService.js';

export const initHelp = `Initialize a Slopify V2 project:\n  slopify init [--cwd <workspace>] [--host <pi|codex|all>] [--yes] [--json] [--verbose]\n\nWithout --host, an interactive terminal prompts for the Agent Host; --yes defaults it to all.\nThe skills download is always automatic, noninteractive, and local to the target project.\n--json never prompts; provide --host or --yes.`;

type InitTerminal = Pick<CliTerminal, 'write' | 'writeError' | 'select'>;
interface InitCliDependencies { packageRoot: string; execute?: SubprocessExecutor; interactive?: boolean }

export async function runInitCli(argv: string[], terminal: InitTerminal, baseCwd: string, dependencies: InitCliDependencies): Promise<number> {
  const json = argv.includes('--json');
  try {
    const options = parseInitArgs(argv, baseCwd);
    if (options.help) { terminal.write(initHelp); return 0; }
    const service = new InitService({ packageRoot: dependencies.packageRoot });
    let host = options.host;
    const interactive = dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!host && options.yes) host = 'all';
    if (!host && options.json) throw new Error('--json requires --host or --yes; JSON mode never prompts.');
    if (!host && !interactive) throw new Error('A noninteractive init requires --host or --yes.');
    if (!host) {
      const selected = await terminal.select('Choose an Agent Host:', [...await service.supportedHosts(), 'all']);
      if (!selected) throw new Error('Agent Host selection was cancelled.');
      host = selected as InitHost;
    }
    const plan = await service.plan(options.cwd, host);
    const result = await service.apply(plan);
    await pullSkills(options.cwd, terminal, dependencies.execute ?? createNodeSubprocessExecutor(), result);
    terminal.write(options.json ? JSON.stringify(result) : formatResult(options.cwd, host, result, options.verbose));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) terminal.write(JSON.stringify({ result: 'invalid', created: [], overwritten: [], warnings: [], error: message }));
    else terminal.writeError(`Error: ${message}`);
    return 1;
  }
}

async function pullSkills(cwd: string, terminal: InitTerminal, execute: SubprocessExecutor, result: InitResult): Promise<void> {
  const args = ['--yes', 'skills@latest', 'add', 'mattpocock/skills', '--agent', 'universal', '--skill', '*', '--copy', '--yes'];
  try {
    const completed = await execute({ command: 'npx', args, cwd, stdin: 'ignore', onOutput: (_stream, chunk) => terminal.writeError(chunk) });
    if (completed.exitCode !== 0) result.warnings.push(`Skills pull failed with exit code ${completed.exitCode}: ${completed.stderr.trim() || 'no diagnostic output'}`);
  } catch (error) {
    result.warnings.push(`Skills pull failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function formatResult(cwd: string, host: InitHost, result: InitResult, verbose: boolean): string {
  const lines = [`Initialized ${cwd} for ${host}.`, `Created (${result.created.length}):`, ...result.created.map(file => `  ${file}`), `Overwritten (${result.overwritten.length}):`, ...result.overwritten.map(file => `  ${file}`)];
  if (result.warnings.length) lines.push(`Warnings (${result.warnings.length}):`, ...result.warnings.map(warning => `  ${warning}`));
  if (verbose) lines.push('Owned files are overwritten on every init; unrelated files are preserved.');
  return lines.join('\n');
}
