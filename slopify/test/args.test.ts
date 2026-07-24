import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';

import { parseCliArgs } from '../src/args.js';

test('parses the exact run contract without an agent option', () => {
  assert.deepEqual(
    parseCliArgs(['run', 'plan-execute-verify', '--yes', '--verbose', '--', 'add', 'a', 'CLI'], '/repo'),
    {
      kind: 'run',
      pipelineName: 'plan-execute-verify',
      prompt: 'add a CLI',
      cwd: '/repo',
      json: false,
      verbose: true,
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
    verbose: false,
  });
});

test('rejects the obsolete agent selection option', () => {
  assert.throws(
    () => parseCliArgs(['run', 'pipeline', 'prompt', '--agent', 'Vibe']),
    /Unknown option "--agent"/,
  );
});

test('requires a pipeline and prompt', () => {
  assert.throws(
    () => parseCliArgs(['run', 'plan-execute-verify']),
    /Usage: slopify run/,
  );
});

test('parses list json and verbose options without accepting run-only flags', () => {
  assert.deepEqual(parseCliArgs(['list', '--json', '--verbose'], '/repo'), {
    kind: 'list',
    cwd: '/repo',
    json: true,
    verbose: true,
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
  assert.deepEqual(parseCliArgs(['run', 'grill', '--', '--fix', 'pipeline-cli'], '/repo'), {
    kind: 'run',
    pipelineName: 'grill',
    prompt: '--fix pipeline-cli',
    cwd: '/repo',
    json: false,
    verbose: false,
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

test('run requires both pipeline name and prompt', () => {
  assert.throws(
    () => parseCliArgs(['run'], '/repo'),
    /Usage: slopify run/,
  );
  assert.throws(
    () => parseCliArgs(['run', 'pipeline'], '/repo'),
    /Usage: slopify run/,
  );
});

test('list with all valid options', () => {
  const result = parseCliArgs(['list', '--cwd', 'demo', '--json', '--verbose'], '/repo');
  assert.deepEqual(result, {
    kind: 'list',
    cwd: path.resolve('/repo', 'demo'),
    json: true,
    verbose: true,
  });
});

test('run with all valid options', () => {
  const result = parseCliArgs(['run', 'pipeline', 'prompt', '--cwd', 'demo', '--json', '--verbose', '--yes', '--keep-sandboxes'], '/repo');
  assert.deepEqual(result, {
    kind: 'run',
    pipelineName: 'pipeline',
    prompt: 'prompt',
    cwd: path.resolve('/repo', 'demo'),
    json: true,
    verbose: true,
    yes: true,
    keepSandboxes: true,
  });
});

test('run with -y short option', () => {
  const result = parseCliArgs(['run', 'pipeline', 'prompt', '-y'], '/repo');
  assert.equal(result.kind, 'run');
  assert.equal((result as any).yes, true);
  assert.equal((result as any).keepSandboxes, false);
});

test('parses --keep-sandboxes independently from --yes', () => {
  const result = parseCliArgs(['run', 'pipeline', 'prompt', '--keep-sandboxes'], '/repo');
  assert.equal(result.kind, 'run');
  assert.equal((result as any).yes, false);
  assert.equal((result as any).keepSandboxes, true);
});

test('positional delimiter stops option parsing', () => {
  const result = parseCliArgs(['run', 'pipeline', '--', '--fix', 'something'], '/repo');
  assert.equal(result.kind, 'run');
  assert.equal((result as any).prompt, '--fix something');
  assert.equal((result as any).keepSandboxes, false);
});
