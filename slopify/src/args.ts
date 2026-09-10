import * as path from 'node:path';

export type LogLevel = 'quiet' | 'default' | 'verbose' | 'debug';

export interface CliCommonOptions {
  cwd: string;
  json: boolean;
  logLevel: LogLevel;
}

export interface CliListCommand extends CliCommonOptions {
  kind: 'list';
}

export interface CliRunCommand extends CliCommonOptions {
  kind: 'run';
  pipelineName: string;
  prompt: string;
  yes: boolean;
  keepSandboxes?: boolean;
}

export interface CliResumeCommand extends CliCommonOptions {
  kind: 'resume';
  runId: string;
  yes: boolean;
  keepSandboxes?: boolean;
}

export interface CliHelpCommand {
  kind: 'help';
}

export type CliCommand = CliListCommand | CliRunCommand | CliResumeCommand | CliHelpCommand;

export const DEFAULT_PIPELINE = 'grill-spec-tickets-implement-review';

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
  let logLevel: LogLevel = 'default';
  let yes = false;
  let keepSandboxes = false;
  let pipelineOption: string | undefined;
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
    if (value === '--cwd' || value === '-c') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('--cwd requires a path.');
      }
      cwd = path.resolve(baseCwd, next);
      index += 1;
      continue;
    }
    if (value === '--pipeline' || value === '-p') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('--pipeline requires a name.');
      }
      pipelineOption = next.trim();
      index += 1;
      continue;
    }
    if (value === '--json' || value === '-j') {
      json = true;
      continue;
    }
    if (value === '--quiet' || value === '-q') {
      logLevel = 'quiet';
      continue;
    }
    if (value === '--verbose' || value === '-v') {
      logLevel = 'verbose';
      continue;
    }
    if (value === '--debug') {
      logLevel = 'debug';
      continue;
    }
    if (value === '--yes' || value === '-y') {
      yes = true;
      continue;
    }
    if (value === '--keep-sandboxes' || value === '-k') {
      keepSandboxes = true;
      continue;
    }
    if (value.startsWith('-')) {
      throw new Error(`Unknown option "${value}".`);
    }
    positional.push(value);
  }

  if (kind === 'list') {
    if (positional.length > 0 || yes || keepSandboxes || pipelineOption !== undefined) {
      throw new Error('Usage: slopify list [--cwd <path>] [--json] [--verbose]');
    }
    return { kind, cwd, json, logLevel };
  }


  if (kind === 'resume') {
    const runId = positional[0]?.trim();
    if (!runId || positional.length !== 1 || pipelineOption !== undefined) {
      throw new Error('Usage: slopify resume <run-id> [--cwd <path>] [--yes] [--keep-sandboxes] [--json] [--verbose]');
    }
    return { kind, runId, cwd, json, logLevel, yes, keepSandboxes };
  }

  const runUsage = 'Usage: slopify run <prompt> [--pipeline <name>] [--cwd <path>] [--yes] [--keep-sandboxes] [--json] [--quiet] [--verbose] [--debug]';
  const prompt = positional.join(' ').trim();
  if (!prompt) {
    throw new Error(runUsage);
  }

  return {
    kind,
    pipelineName: pipelineOption ?? DEFAULT_PIPELINE,
    prompt,
    cwd,
    json,
    logLevel,
    yes,
    keepSandboxes,
  };
}

export function formatHelp(): string {
  return [
    'slopify - run ACP v3 pipelines and Docker Sandbox agents (Codex, Copilot, OpenCode, Vibe) from a terminal.',
    '',
    'The pipeline selects every native ACP or Docker Sandbox agent used by its',
    'nodes, based on the workspace configuration. There is intentionally no --agent option.',
    '',
    'Usage:',
    '  slopify <command> [options] [--] [args...]',
    '',
    'Commands:',
    '  list                 List the v3 pipelines available in the workspace.',
    '  run <prompt>         Run a pipeline against a prompt.',
    '  resume <run-id>      Resume an interrupted run by its persisted run id.',
    '',
    'Options:',
    '  --pipeline, -p <name>  Pipeline to run (default: grill-spec-tickets-implement-review).',
    '  --cwd, -c <path>       Workspace to use (default: current directory).',
    '  --yes, -y              Approve approval pauses only; never approves a Promotion.',
    '  --keep-sandboxes, -k   Keep Docker Sandboxes for local diagnostics.',
    '  --quiet, -q            Suppress all status output (artifact only on stdout).',
    '  --verbose, -v          Print runtime events and agent activity.',
    '  --debug                Print everything, including raw agent traces and diffs.',
    '  --json, -j             Serialize the pipeline list or the final result as JSON.',
    '  --help, -h             Show this help.',
    '',
    'Notes:',
    '  The pipeline is selected with --pipeline/-p and defaults to',
    '  grill-spec-tickets-implement-review when omitted. All positional arguments form the',
    '  prompt. --yes never approves a Promotion. The pipeline policy decides whether the',
    '  Pipeline Change Set is rejected, presented, applied, or auto-rejected.',
    '  --keep-sandboxes preserves every Docker Sandbox created by the run.',
    '',
    'Examples:',
    '  slopify list -j',
    '  slopify run "Add an export command" -y',
    '  slopify run -p implement-ticket "Fix the bug"',
    '  slopify resume run-42 -k -v',
  ].join('\n');
}
