import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';

import { parseCliArgs, formatHelp, DEFAULT_PIPELINE } from '../src/args.js';

test('parses the exact run contract without an agent option', () => {
  assert.deepEqual(
    parseCliArgs(['run', '--pipeline', 'plan-execute-verify', '--yes', '--verbose', '--', 'add', 'a', 'CLI'], '/repo'),
    {
      kind: 'run',
      pipelineName: 'plan-execute-verify',
      prompt: 'add a CLI',
      cwd: '/repo',
      json: false,
      logLevel: 'verbose',
      yes: true,
      keepSandboxes: false,
    },
  );
});

test('resolves cwd portably', () => {
  assert.deepEqual(parseCliArgs(['list', '--cwd', 'demo'], '/repo'), {
    kind: 'list',
    cwd: path.resolve('/repo', 'demo'),
    json: false,
    logLevel: 'default',
  });
});

test('rejects the obsolete agent selection option', () => {
  assert.throws(
    () => parseCliArgs(['run', '-p', 'pipeline', 'prompt', '--agent', 'Vibe']),
    /Unknown option "--agent"/,
  );
});

test('requires a prompt', () => {
  assert.throws(
    () => parseCliArgs(['run']),
    /Usage: slopify run/,
  );
});

test('parses list json and verbose options without accepting run-only flags', () => {
  assert.deepEqual(parseCliArgs(['list', '--json', '--verbose'], '/repo'), {
    kind: 'list',
    cwd: '/repo',
    json: true,
    logLevel: 'verbose',
  });

  assert.throws(
    () => parseCliArgs(['list', '--yes'], '/repo'),
    /Usage: slopify list/,
  );
  assert.throws(
    () => parseCliArgs(['list', '--keep-sandboxes'], '/repo'),
    /Usage: slopify list/,
  );
});

test('keeps prompt-looking options after the positional delimiter', () => {
  assert.deepEqual(parseCliArgs(['run', '-p', 'grill', '--', '--fix', 'pipeline-cli'], '/repo'), {
    kind: 'run',
    pipelineName: 'grill',
    prompt: '--fix pipeline-cli',
    cwd: '/repo',
    json: false,
    logLevel: 'default',
    yes: false,
    keepSandboxes: false,
  });
});

test('requires a value for --cwd', () => {
  assert.throws(
    () => parseCliArgs(['run', '--cwd'], '/repo'),
    /--cwd requires a path/,
  );
});

test('--help returns help command', () => {
  const result = parseCliArgs(['--help'], '/repo');
  assert.deepEqual(result, { kind: 'help' });
});

test('-h returns help command', () => {
  const result = parseCliArgs(['-h'], '/repo');
  assert.deepEqual(result, { kind: 'help' });
});

test('empty argv returns help command', () => {
  const result = parseCliArgs([], '/repo');
  assert.deepEqual(result, { kind: 'help' });
});

test('formatHelp documents run, --pipeline, short options, the missing --agent option, and examples', () => {
  const help = formatHelp();
  assert.match(help, /\brun\b/);
  assert.match(help, /--pipeline/);
  assert.match(help, /-p <name>/);
  assert.match(help, /--yes/);
  assert.match(help, /-y/);
  assert.match(help, /--cwd, -c/);
  assert.match(help, /--keep-sandboxes, -k/);
  assert.match(help, /--verbose, -v/);
  assert.match(help, /--quiet, -q/);
  assert.match(help, /--debug/);
  assert.match(help, /--json, -j/);
  assert.match(help, /no --agent option/);
  assert.match(help, /never approves a Promotion/);
  assert.match(help, /All positional arguments form the/);
  assert.match(help, /Examples:/);
  assert.match(help, /slopify list/);
  assert.match(help, /slopify run/);
  assert.match(help, /slopify resume/);
});

test('unknown command throws error with help text', () => {
  assert.throws(
    () => parseCliArgs(['unknown-command'], '/repo'),
    /Unknown command "unknown-command"/,
  );
});

test('unknown option throws error', () => {
  assert.throws(
    () => parseCliArgs(['list', '--unknown'], '/repo'),
    /Unknown option "--unknown"/,
  );
});

test('run requires a prompt', () => {
  assert.throws(
    () => parseCliArgs(['run'], '/repo'),
    /Usage: slopify run/,
  );
});

test('run with a single positional defaults the pipeline', () => {
  const result = parseCliArgs(['run', 'add comments'], '/repo');
  assert.deepEqual(result, {
    kind: 'run',
    pipelineName: DEFAULT_PIPELINE,
    prompt: 'add comments',
    cwd: '/repo',
    json: false,
    logLevel: 'default',
    yes: false,
    keepSandboxes: false,
  });
});

test('run --pipeline selects the pipeline and treats positionals as the prompt', () => {
  const result = parseCliArgs(['run', '--pipeline', 'implement-ticket', 'fix', 'the', 'bug'], '/repo');
  assert.deepEqual(result, {
    kind: 'run',
    pipelineName: 'implement-ticket',
    prompt: 'fix the bug',
    cwd: '/repo',
    json: false,
    logLevel: 'default',
    yes: false,
    keepSandboxes: false,
  });
});

test('run -p short form selects the pipeline', () => {
  const result = parseCliArgs(['run', '-p', 'review-delivery', 'review this'], '/repo');
  assert.equal(result.kind, 'run');
  assert.equal((result as any).pipelineName, 'review-delivery');
  assert.equal((result as any).prompt, 'review this');
});

test('run joins all positionals into the prompt', () => {
  const result = parseCliArgs(['run', 'grill-spec-tickets-implement-review', 'do', 'it', 'now'], '/repo');
  assert.equal((result as any).pipelineName, DEFAULT_PIPELINE);
  assert.equal((result as any).prompt, 'grill-spec-tickets-implement-review do it now');
});

test('run --pipeline requires a name', () => {
  assert.throws(
    () => parseCliArgs(['run', '-p'], '/repo'),
    /--pipeline requires a name/,
  );
});

test('run --pipeline without a prompt is a usage error', () => {
  assert.throws(
    () => parseCliArgs(['run', '--pipeline', 'implement-ticket'], '/repo'),
    /Usage: slopify run/,
  );
});

test('list rejects --pipeline', () => {
  assert.throws(
    () => parseCliArgs(['list', '--pipeline', 'implement-ticket'], '/repo'),
    /Usage: slopify list/,
  );
});

test('resume rejects --pipeline', () => {
  assert.throws(
    () => parseCliArgs(['resume', 'run-42', '-p', 'implement-ticket'], '/repo'),
    /Usage: slopify resume/,
  );
});

test('short forms -c -j -v -k work for run', () => {
  const result = parseCliArgs(['run', '-p', 'pipeline', 'prompt', '-c', 'demo', '-j', '-v', '-y', '-k'], '/repo');
  assert.deepEqual(result, {
    kind: 'run',
    pipelineName: 'pipeline',
    prompt: 'prompt',
    cwd: path.resolve('/repo', 'demo'),
    json: true,
    logLevel: 'verbose',
    yes: true,
    keepSandboxes: true,
  });
});

test('short forms -c -j -v work for list', () => {
  const result = parseCliArgs(['list', '-c', 'demo', '-j', '-v'], '/repo');
  assert.deepEqual(result, {
    kind: 'list',
    cwd: path.resolve('/repo', 'demo'),
    json: true,
    logLevel: 'verbose',
  });
});

test('list with all valid options', () => {
  const result = parseCliArgs(['list', '--cwd', 'demo', '--json', '--verbose'], '/repo');
  assert.deepEqual(result, {
    kind: 'list',
    cwd: path.resolve('/repo', 'demo'),
    json: true,
    logLevel: 'verbose',
  });
});

test('run with all valid options', () => {
  const result = parseCliArgs(['run', '-p', 'pipeline', 'prompt', '--cwd', 'demo', '--json', '--verbose', '--yes', '--keep-sandboxes'], '/repo');
  assert.deepEqual(result, {
    kind: 'run',
    pipelineName: 'pipeline',
    prompt: 'prompt',
    cwd: path.resolve('/repo', 'demo'),
    json: true,
    logLevel: 'verbose',
    yes: true,
    keepSandboxes: true,
  });
});

test('run with -y short option', () => {
  const result = parseCliArgs(['run', '-p', 'pipeline', 'prompt', '-y'], '/repo');
  assert.equal(result.kind, 'run');
  assert.equal((result as any).yes, true);
  assert.equal((result as any).keepSandboxes, false);
});

test('parses crash recovery by persisted run id', () => {
  assert.deepEqual(parseCliArgs(['resume', 'run-42', '--yes', '--json'], '/repo'), {
    kind: 'resume', runId: 'run-42', cwd: '/repo', json: true, logLevel: 'default',
    yes: true, keepSandboxes: false,
  });
});

test('parses --keep-sandboxes independently from --yes', () => {
  const result = parseCliArgs(['run', '-p', 'pipeline', 'prompt', '--keep-sandboxes'], '/repo');
  assert.equal(result.kind, 'run');
  assert.equal((result as any).yes, false);
  assert.equal((result as any).keepSandboxes, true);
});

test('positional delimiter stops option parsing', () => {
  const result = parseCliArgs(['run', '-p', 'pipeline', '--', '--fix', 'something'], '/repo');
  assert.equal(result.kind, 'run');
  assert.equal((result as any).prompt, '--fix something');
  assert.equal((result as any).keepSandboxes, false);
});

test('--quiet sets logLevel to quiet', () => {
  const result = parseCliArgs(['run', '-q', 'prompt'], '/repo');
  assert.equal((result as any).logLevel, 'quiet');
});

test('-q short form sets logLevel to quiet', () => {
  const result = parseCliArgs(['run', 'prompt', '-q'], '/repo');
  assert.equal((result as any).logLevel, 'quiet');
});

test('--debug sets logLevel to debug', () => {
  const result = parseCliArgs(['run', '--debug', 'prompt'], '/repo');
  assert.equal((result as any).logLevel, 'debug');
});

test('--quiet takes precedence over --verbose when both are passed', () => {
  const result = parseCliArgs(['run', '--verbose', '--quiet', 'prompt'], '/repo');
  assert.equal((result as any).logLevel, 'quiet');
});

test('default logLevel is default when no verbosity flag is given', () => {
  const result = parseCliArgs(['run', 'prompt'], '/repo');
  assert.equal((result as any).logLevel, 'default');
});
