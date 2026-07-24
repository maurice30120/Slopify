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

function successfulResponse(request: SubprocessRequest): SubprocessResult {
  if (request.command === 'git' && request.args[0] === 'rev-parse') return result('true\n');
  if (request.command === 'git' && request.args[0] === 'status') return result();
  if (request.args.join(' ') === 'version') return result('Docker Sandbox 0.35.0\n');
  if (request.args.join(' ') === 'create --help') return result('Usage: sbx create --clone');
  if (request.args.join(' ') === 'ls --help') return result('Usage: sbx ls --json');
  if (request.args.join(' ') === 'policy init --help') return result('Usage: sbx policy init');
  return result();
}

test('runs Codex with a stable cloned sandbox, closed stdin, and nominal cleanup', async () => {
  const fake = fakeExecutor(successfulResponse);
  const runtime = new DockerSandboxRuntime(fake.execute);
  const output = await runtime.runCodex({
    workspaceCwd: '/repo', runId: 'Run 42', nodeId: 'Implement/API', attempt: 2,
    prompt: 'Do nothing.', model: 'gpt-5.6-codex', effort: 'high', workspaceEffects: true,
  });

  const expectedName = stableSandboxName('Run 42', 'Implement/API', 2);
  assert.equal(output.status, 'no_changes');
  assert.equal(output.sandboxName, expectedName);
  assert.deepEqual(fake.calls.find(call => call.args[0] === 'create' && call.args.includes('--clone'))?.args, ['create', '--clone', '--name', expectedName, 'codex', '.']);
  const codex = fake.calls.find(call => call.args[0] === 'exec' && call.args.includes('codex'));
  assert.ok(codex);
  assert.equal(codex.stdin, 'ignore');
  assert.equal(codex.observeOutput, true);
  assert.deepEqual(fake.calls.at(-1)?.args, ['rm', '--force', expectedName]);
});

test('rejects a dirty workspace before creating a sandbox with corrective guidance', async () => {
  const fake = fakeExecutor(request => {
    if (request.command === 'git' && request.args[0] === 'rev-parse') return result('true\n');
    if (request.command === 'git' && request.args[0] === 'status') return result(' M local.ts\n');
    return successfulResponse(request);
  });

  await assert.rejects(
    new DockerSandboxRuntime(fake.execute).runCodex({ workspaceCwd: '/repo', runId: 'run', nodeId: 'node', attempt: 1, prompt: 'x', model: 'gpt', workspaceEffects: true }),
    /sbx --clone cannot see uncommitted changes, so safe Promotion is impossible/,
  );
  assert.equal(fake.calls.some(call => call.args[0] === 'create'), false);
});

test('does not apply the clean-workspace check to a read-only pipeline node', async () => {
  const fake = fakeExecutor(request => {
    if (request.command === 'git' && request.args[0] === 'status') return result(' M local.ts\n');
    return successfulResponse(request);
  });
  await new DockerSandboxRuntime(fake.execute).runCodex({ workspaceCwd: '/repo', runId: 'run', nodeId: 'read', attempt: 1, prompt: 'inspect', model: 'gpt', workspaceEffects: false });
  assert.equal(fake.calls.some(call => call.command === 'git' && call.args[0] === 'status'), false);
  assert.equal(fake.calls.some(call => call.args[0] === 'create'), true);
});

test('requires sbx 0.35.0 and required clone/list capabilities', async () => {
  const old = fakeExecutor(request => request.args.join(' ') === 'version' ? result('sbx 0.34.9') : successfulResponse(request));
  await assert.rejects(new DockerSandboxRuntime(old.execute).preflightWorkspace('/repo'), /0\.35\.0 or newer.*0\.34\.9/);

  const missing = fakeExecutor(request => request.args.join(' ') === 'create --help' ? result('Usage: sbx create') : successfulResponse(request));
  await assert.rejects(new DockerSandboxRuntime(missing.execute).preflightWorkspace('/repo'), /required --clone capability/);
});

test('cleans the sandbox when Codex fails', async () => {
  const fake = fakeExecutor(request => request.args[0] === 'exec' && request.args.includes('codex')
    ? result('', 'codex failed', 7)
    : successfulResponse(request));
  await assert.rejects(new DockerSandboxRuntime(fake.execute).runCodex({ workspaceCwd: '/repo', runId: 'run', nodeId: 'node', attempt: 1, prompt: 'x', model: 'gpt' }), /codex failed/);
  assert.deepEqual(fake.calls.at(-1)?.args.slice(0, 2), ['rm', '--force']);
});
