import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DockerSandboxRuntime,
  stableSandboxName,
  type SubprocessExecutor,
  type SubprocessRequest,
  type SubprocessResult,
} from '../src/index.js';

function result(stdout = '', stderr = '', exitCode = 0): SubprocessResult {
  return { exitCode, stdout, stderr };
}

function fakeExecutor(respond: (request: SubprocessRequest) => SubprocessResult): { execute: SubprocessExecutor; calls: SubprocessRequest[] } {
  const calls: SubprocessRequest[] = [];
  return {
    calls,
    execute: async request => {
      calls.push(request);
      return respond(request);
    },
  };
}

function sandboxScenario(options: {
  changedFiles?: string[];
  diff?: string;
  checkpointFailure?: string;
  fetchFailure?: string;
} = {}): { respond: (request: SubprocessRequest) => SubprocessResult } {
  return {
    respond(request) {
      if (request.command === 'git' && request.args.join(' ') === 'rev-parse --is-inside-work-tree') return result('true\n');
      if (request.command === 'git' && request.args.join(' ') === 'rev-parse HEAD') return result('base123\n');
      if (request.command === 'git' && request.args[0] === 'rev-parse') return result('checkpoint456\n');
      if (request.command === 'git' && request.args[0] === 'status') return result();
      if (request.command === 'git' && request.args[0] === 'fetch') {
        return options.fetchFailure ? result('', options.fetchFailure, 1) : result();
      }
      if (request.command === 'git' && request.args[0] === 'diff' && request.args.includes('--name-only')) {
        return result((options.changedFiles ?? []).map(path => `${path}\n`).join(''));
      }
      if (request.command === 'git' && request.args[0] === 'diff') return result(options.diff ?? '');

      if (request.args.join(' ') === 'version') return result('Docker Sandbox 0.35.0\n');
      if (request.args.join(' ') === 'create --help') return result('Usage: sbx create --clone');
      if (request.args.join(' ') === 'ls --help') return result('Usage: sbx ls --json');
      if (request.args.join(' ') === 'policy init --help') return result('Usage: sbx policy init');

      const sandboxGitArgs = request.command === 'sbx' && request.args[0] === 'exec'
        ? request.args.slice(2)
        : [];
      if (sandboxGitArgs[0] === 'git' && sandboxGitArgs.includes('commit')) {
        if (options.checkpointFailure) return result('', options.checkpointFailure, 1);
        return result('[feature checkpoint456] checkpoint\n');
      }
      return result();
    },
  };
}

function hostMutatingGitCalls(calls: SubprocessRequest[]): SubprocessRequest[] {
  const mutating = new Set(['checkout', 'switch', 'reset', 'merge', 'cherry-pick', 'rebase', 'apply', 'am']);
  return calls.filter(call => call.command === 'git' && mutating.has(call.args[0] ?? ''));
}

test('creates and previews an attributed Agent Checkpoint without mutating the host workspace', async () => {
  const scenario = sandboxScenario({
    changedFiles: ['src/feature.ts', 'README.md'],
    diff: 'diff --git a/src/feature.ts b/src/feature.ts\n+checkpoint change\n',
  });
  const fake = fakeExecutor(scenario.respond);
  const runtime = new DockerSandboxRuntime(fake.execute);

  const output = await runtime.runCodex({
    workspaceCwd: '/repo',
    runId: 'Run 42',
    nodeId: 'Implement/API',
    attempt: 2,
    prompt: 'Implement the feature.',
    model: 'gpt-5.6-codex',
    effort: 'high',
    workspaceEffects: true,
  });

  const sandboxName = stableSandboxName('Run 42', 'Implement/API', 2);
  const checkpointRef = `refs/slopify/checkpoints/${sandboxName}`;
  assert.equal(output.status, undefined);
  assert.equal(output.checkpointStatus, 'checkpointed');
  assert.equal(output.sandboxName, sandboxName);
  assert.deepEqual(output.checkpoint, {
    runId: 'Run 42',
    nodeId: 'Implement/API',
    attempt: 2,
    sandboxName,
    baseCommit: 'base123',
    commit: 'checkpoint456',
    remote: `sandbox-${sandboxName}`,
    ref: checkpointRef,
  });
  assert.deepEqual(output.preview, {
    baseCommit: 'base123',
    checkpointCommit: 'checkpoint456',
    fileCount: 2,
    files: ['src/feature.ts', 'README.md'],
    diff: 'diff --git a/src/feature.ts b/src/feature.ts\n+checkpoint change\n',
  });

  const commit = fake.calls.find(call => call.command === 'sbx' && call.args.includes('commit'));
  assert.ok(commit);
  assert.ok(commit.args.includes('--allow-empty'));
  assert.ok(commit.args.includes('user.name=Slopify'));
  assert.ok(commit.args.includes('user.email=slopify@localhost'));
  assert.ok(commit.args.includes('commit.gpgsign=false'));
  assert.ok(commit.args.includes('--no-verify'));
  assert.ok(commit.args.includes('Slopify-Run: Run 42'));
  assert.ok(commit.args.includes('Slopify-Node: Implement/API'));
  assert.ok(commit.args.includes('Slopify-Attempt: 2'));

  const fetch = fake.calls.find(call => call.command === 'git' && call.args[0] === 'fetch');
  assert.deepEqual(fetch?.args, [
    'fetch',
    '--no-tags',
    `sandbox-${sandboxName}`,
    `HEAD:${checkpointRef}`,
  ]);
  assert.deepEqual(hostMutatingGitCalls(fake.calls), []);
  assert.deepEqual(fake.calls.at(-1)?.args, ['rm', '--force', sandboxName]);
});

test('creates an empty technical checkpoint and returns no_changes when its preview is empty', async () => {
  const fake = fakeExecutor(sandboxScenario().respond);
  const output = await new DockerSandboxRuntime(fake.execute).runCodex({
    workspaceCwd: '/repo', runId: 'run', nodeId: 'node', attempt: 1,
    prompt: 'Do nothing.', model: 'gpt', workspaceEffects: true,
  });

  assert.equal(output.status, 'no_changes');
  assert.equal(output.checkpointStatus, 'no_changes');
  assert.equal(output.checkpoint.commit, 'checkpoint456');
  assert.equal(output.preview.fileCount, 0);
  assert.deepEqual(output.preview.files, []);
  assert.equal(output.preview.diff, '');
  assert.equal(fake.calls.some(call => call.command === 'sbx' && call.args.includes('commit') && call.args.includes('--allow-empty')), true);
});

test('stops after a checkpoint failure and never fetches or previews implicitly', async () => {
  const fake = fakeExecutor(sandboxScenario({ checkpointFailure: 'commit failed' }).respond);
  await assert.rejects(
    new DockerSandboxRuntime(fake.execute).runCodex({
      workspaceCwd: '/repo', runId: 'run', nodeId: 'node', attempt: 1,
      prompt: 'Change files.', model: 'gpt', workspaceEffects: true,
    }),
    /Unable to create the Agent Checkpoint: commit failed/,
  );

  assert.equal(fake.calls.some(call => call.command === 'git' && call.args[0] === 'fetch'), false);
  assert.equal(fake.calls.some(call => call.command === 'git' && call.args[0] === 'diff'), false);
  assert.deepEqual(fake.calls.at(-1)?.args.slice(0, 2), ['rm', '--force']);
});

test('stops after a checkpoint fetch failure and never produces an implicit preview or Promotion', async () => {
  const fake = fakeExecutor(sandboxScenario({ fetchFailure: 'remote unavailable' }).respond);
  await assert.rejects(
    new DockerSandboxRuntime(fake.execute).runCodex({
      workspaceCwd: '/repo', runId: 'run', nodeId: 'node', attempt: 1,
      prompt: 'Change files.', model: 'gpt', workspaceEffects: true,
    }),
    /Unable to fetch the Agent Checkpoint: remote unavailable/,
  );

  assert.equal(fake.calls.some(call => call.command === 'git' && call.args[0] === 'diff'), false);
  assert.deepEqual(hostMutatingGitCalls(fake.calls), []);
  assert.deepEqual(fake.calls.at(-1)?.args.slice(0, 2), ['rm', '--force']);
});

test('rejects a dirty workspace before creating a sandbox with corrective guidance', async () => {
  const fake = fakeExecutor(request => {
    if (request.command === 'git' && request.args[0] === 'rev-parse') return result('true\n');
    if (request.command === 'git' && request.args[0] === 'status') return result(' M local.ts\n');
    return sandboxScenario().respond(request);
  });

  await assert.rejects(
    new DockerSandboxRuntime(fake.execute).runCodex({ workspaceCwd: '/repo', runId: 'run', nodeId: 'node', attempt: 1, prompt: 'x', model: 'gpt', workspaceEffects: true }),
    /sbx --clone cannot see uncommitted changes, so safe Promotion is impossible/,
  );
  assert.equal(fake.calls.some(call => call.args[0] === 'create'), false);
});

test('does not apply the clean-workspace check to a read-only pipeline node', async () => {
  const scenario = sandboxScenario();
  const fake = fakeExecutor(request => {
    if (request.command === 'git' && request.args[0] === 'status') return result(' M local.ts\n');
    return scenario.respond(request);
  });
  await new DockerSandboxRuntime(fake.execute).runCodex({ workspaceCwd: '/repo', runId: 'run', nodeId: 'read', attempt: 1, prompt: 'inspect', model: 'gpt', workspaceEffects: false });
  assert.equal(fake.calls.some(call => call.command === 'git' && call.args[0] === 'status'), false);
  assert.equal(fake.calls.some(call => call.args[0] === 'create'), true);
});

test('requires sbx 0.35.0 and required clone/list capabilities', async () => {
  const baseline = sandboxScenario();
  const old = fakeExecutor(request => request.args.join(' ') === 'version' ? result('sbx 0.34.9') : baseline.respond(request));
  await assert.rejects(new DockerSandboxRuntime(old.execute).preflightWorkspace('/repo'), /0\.35\.0 or newer.*0\.34\.9/);

  const missingBaseline = sandboxScenario();
  const missing = fakeExecutor(request => request.args.join(' ') === 'create --help' ? result('Usage: sbx create') : missingBaseline.respond(request));
  await assert.rejects(new DockerSandboxRuntime(missing.execute).preflightWorkspace('/repo'), /required --clone capability/);
});

test('cleans the sandbox when Codex fails', async () => {
  const scenario = sandboxScenario();
  const fake = fakeExecutor(request => request.args[0] === 'exec' && request.args.includes('codex')
    ? result('', 'codex failed', 7)
    : scenario.respond(request));
  await assert.rejects(new DockerSandboxRuntime(fake.execute).runCodex({ workspaceCwd: '/repo', runId: 'run', nodeId: 'node', attempt: 1, prompt: 'x', model: 'gpt' }), /codex failed/);
  assert.deepEqual(fake.calls.at(-1)?.args.slice(0, 2), ['rm', '--force']);
});
