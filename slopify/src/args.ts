import * as path from 'node:path';

export interface CliCommonOptions {
  cwd: string;
  json: boolean;
  verbose: boolean;
}

export interface CliListCommand extends CliCommonOptions {
  kind: 'list';
}

export interface CliRunCommand extends CliCommonOptions {
  kind: 'run';
  pipelineName: string;
  prompt: string;
  agent: string;
  yes: boolean;
  keepSandboxes?: boolean;
}

export interface CliResumeCommand extends CliCommonOptions {
  kind: 'resume';
  runId: string;
  agent: string;
  yes: boolean;
  keepSandboxes?: boolean;
}

export interface CliHelpCommand {
  kind: 'help';
}

export type CliCommand = CliListCommand | CliRunCommand | CliResumeCommand | CliHelpCommand;

export function parseCliArgs(argv: string[], baseCwd = process.cwd()): CliCommand {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return { kind: 'help' };
  }

  const kind = argv[0];
  if (kind !== 'list' && kind !== 'run' && kind !== 'resume') {
    throw new Error(`Unknown command "${kind}".\n\n${formatHelp()}`);
  }

  let cwd = baseCwd;
  let json = false;
  let verbose = false;
  let agent: string | undefined;
  let yes = false;
  let keepSandboxes = false;
  const positional: string[] = [];
  let positionalOnly = false;

  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (positionalOnly) {
      positional.push(value);
      continue;
    }
    if (value === '--') {
      positionalOnly = true;
      continue;
    }
    if (value === '--cwd') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('--cwd requires a path.');
      }
      cwd = path.resolve(baseCwd, next);
      index += 1;
      continue;
    }
    if (value === '--json') {
      json = true;
      continue;
    }
    if (value === '--verbose') {
      verbose = true;
      continue;
    }
    if (value === '--agent') {
      const next = argv[index + 1]?.trim();
      if (!next) {
        throw new Error('--agent requires a name.');
      }
      agent = next;
      index += 1;
      continue;
    }
    if (value === '--yes' || value === '-y') {
      yes = true;
      continue;
    }
    if (value === '--keep-sandboxes') {
      keepSandboxes = true;
      continue;
    }
    if (value.startsWith('-')) {
      throw new Error(`Unknown option "${value}".`);
    }
    positional.push(value);
  }

  if (kind === 'list') {
    if (positional.length > 0 || agent || yes || keepSandboxes) {
      throw new Error('Usage: slopify list [--cwd <path>] [--json] [--verbose]');
    }
    return { kind, cwd, json, verbose };
  }


  if (kind === 'resume') {
    const runId = positional[0]?.trim();
    if (!runId || positional.length !== 1 || !agent) {
      throw new Error('Usage: slopify resume <run-id> --agent <name> [--cwd <path>] [--yes] [--keep-sandboxes] [--json] [--verbose]');
    }
    return { kind, runId, agent, cwd, json, verbose, yes, keepSandboxes };
  }

  const pipelineName = positional[0]?.trim();
  const prompt = positional.slice(1).join(' ').trim();
  if (!pipelineName || !prompt || !agent) {
    throw new Error(
      'Usage: slopify run <pipeline-name> <prompt> --agent <name> [--cwd <path>] [--yes] [--keep-sandboxes] [--json] [--verbose]',
    );
  }

  return {
    kind,
    pipelineName,
    prompt,
    agent,
    cwd,
    json,
    verbose,
    yes,
    keepSandboxes,
  };
}

export function formatHelp(): string {
  return [
    'Slopify',
    '',
    'Usage:',
    '  slopify list [--cwd <path>] [--json] [--verbose]',
    '  slopify run <pipeline-name> <prompt> --agent <name> [--cwd <path>] [--yes] [--keep-sandboxes] [--json] [--verbose]',
    '  slopify resume <run-id> --agent <name> [--cwd <path>] [--yes] [--keep-sandboxes] [--json] [--verbose]',
    '',
    'Pipelines do not select an agent. --agent selects one configured workspace agent for every agent node.',
    'Agent names come from .acp/acp-agents.json. Pass the same --agent when resuming a run after a process restart.',
    '--agent <name> selects the configured agent for every agent node.',
    '--keep-sandboxes preserves every Docker Sandbox created by the run for local diagnostics.',
  ].join('\n');
}
