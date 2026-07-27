import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.SLOPIFY_SBX_SMOKE !== '1') {
  console.log('Docker Sandbox smoke test skipped. Set SLOPIFY_SBX_SMOKE=1 to run it.');
  process.exit(0);
}

const action = process.env.SLOPIFY_SBX_SMOKE_ACTION ?? 'reject';
if (action !== 'promote' && action !== 'reject') {
  throw new Error('SLOPIFY_SBX_SMOKE_ACTION must be "promote" or "reject".');
}

const repo = mkdtempSync(join(tmpdir(), 'slopify-sbx-smoke-'));
const marker = 'codex-smoke-marker.txt';
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const cli = resolve(scriptDirectory, '../../slopify/dist/src/cli.js');
const model = process.env.SLOPIFY_SBX_SMOKE_MODEL ?? 'gpt-5.4';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repo,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  const accepted = options.acceptedStatuses ?? [0];
  if (!accepted.includes(result.status)) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return options.capture ? { stdout: result.stdout.trim(), stderr: result.stderr.trim(), status: result.status } : result;
}

function sandboxNames() {
  const output = run('sbx', ['ls', '--json'], { capture: true }).stdout;
  const parsed = JSON.parse(output);
  const entries = Array.isArray(parsed) ? parsed : parsed.sandboxes ?? [];
  return new Set(entries.flatMap(entry => {
    const name = entry?.name ?? entry?.Name;
    return typeof name === 'string' ? [name] : [];
  }));
}

function smokeSandboxNames() {
  const directory = join(repo, '.acp', 'logs', 'sandboxes');
  if (!existsSync(directory)) return new Set();
  return new Set(readdirSync(directory).flatMap(file => {
    if (!file.endsWith('.json')) return [];
    const diagnostic = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    return typeof diagnostic.sandboxName === 'string' ? [diagnostic.sandboxName] : [];
  }));
}

let before;
let primaryError;
try {
  run('git', ['init', '--initial-branch=main']);
  run('git', ['config', 'user.name', 'Slopify Smoke']);
  run('git', ['config', 'user.email', 'slopify-smoke@localhost']);
  writeFileSync(join(repo, 'README.md'), '# Docker Sandbox smoke fixture\n');
  run('git', ['add', 'README.md']);
  run('git', ['commit', '-m', 'chore: initialize smoke fixture']);
  const baseCommit = run('git', ['rev-parse', 'HEAD'], { capture: true }).stdout;

  run('sbx', ['version']);
  before = sandboxNames();
  mkdirSync(join(repo, '.acp', 'pipelines'), { recursive: true });
  writeFileSync(join(repo, '.acp', 'acp-agents.json'), JSON.stringify({
    agents: {
      'Codex Sandbox': { transport: 'sandbox', agent: 'codex', model },
    },
    pipeline: { enabled: true },
  }, null, 2));
  writeFileSync(join(repo, '.acp', 'pipelines', 'smoke.yaml'), `
version: 3
id: docker-sandbox-smoke
title: Docker Sandbox Codex smoke
promotion: ${action === 'promote' ? 'auto-apply' : 'auto-reject'}
nodes:
  - id: implement
    agent: Codex Sandbox
    prompt: >-
      Create exactly one file named ${marker} containing exactly
      docker sandbox codex smoke followed by one newline. Do not modify any
      other file and do not commit.
    policy:
      filesystem: workspace-write
      terminal: workspace-write
    output:
      name: result
      type: text
      format: text
`);
  run('git', ['add', '.acp']);
  run('git', ['commit', '-m', 'chore: configure Slopify smoke pipeline']);
  const pipelineBase = run('git', ['rev-parse', 'HEAD'], { capture: true }).stdout;

  const result = run(process.execPath, [
    cli,
    'run',
    'docker-sandbox-smoke',
    'Run the Docker Sandbox smoke path.',
    '--cwd', repo,
    '--json',
  ], { capture: true, acceptedStatuses: action === 'promote' ? [0] : [2] });
  const expectedStatus = action === 'promote' ? 'completed' : 'rejected';
  if (!result.stdout.includes(`"status": "${expectedStatus}"`)) {
    throw new Error(`Slopify did not report the expected ${expectedStatus} result: ${result.stderr || result.stdout}`);
  }

  if (action === 'promote') {
    if (readFileSync(join(repo, marker), 'utf8') !== 'docker sandbox codex smoke\n') {
      throw new Error('Slopify Promotion did not apply the expected marker content.');
    }
    if (run('git', ['rev-parse', 'HEAD'], { capture: true }).stdout === pipelineBase) {
      throw new Error('Slopify reported success without promoting the Pipeline Change Set.');
    }
  } else if (
    run('git', ['rev-parse', 'HEAD'], { capture: true }).stdout !== pipelineBase
    || existsSync(join(repo, marker))
    || readFileSync(join(repo, 'README.md'), 'utf8') !== '# Docker Sandbox smoke fixture\n'
  ) {
    throw new Error('Slopify rejection mutated the host repository.');
  }

  console.log(JSON.stringify({
    action,
    baseCommit,
    pipelineBase,
    model,
    cliExitCode: result.status,
    status: 'passed',
  }, null, 2));
} catch (error) {
  primaryError = error;
}

let cleanupError;
try {
  if (!before) throw new Error('Unable to verify cleanup because the pre-run Docker Sandbox inventory was not captured.');
  const after = sandboxNames();
  const owned = smokeSandboxNames();
  if (owned.size === 0 && primaryError === undefined) {
    throw new Error('Slopify produced no Docker Sandbox diagnostic, so cleanup cannot be verified.');
  }
  const leaked = [...owned].filter(name => !before.has(name) && after.has(name));
  if (leaked.length > 0) {
    for (const name of leaked) {
      run('sbx', ['rm', '--force', name]);
    }
    cleanupError = new Error(`Slopify left Docker Sandbox resources behind: ${leaked.join(', ')}`);
  }
} catch (error) {
  cleanupError = error;
} finally {
  rmSync(repo, { recursive: true, force: true });
}

if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], 'Smoke path and cleanup both failed.');
if (primaryError) throw primaryError;
if (cleanupError) throw cleanupError;
