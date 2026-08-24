import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DOCKER_SANDBOX_NETWORK_POLICY_CHOICES,
  DockerSandboxRuntime,
  SANDBOX_EXTENSION_METHODS,
  SandboxRunCancelledError,
  SandboxRunTimeoutError,
  retainedSandboxCommands,
  stableSandboxName,
  type DockerSandboxNetworkPolicyChoice,
  type DockerSandboxNetworkPolicyPreset,
  type RetainedSandbox,
  type SandboxRunState,
  type SubprocessExecutor,
  type SubprocessRequest,
  type SubprocessResult,
} from '../src/index.js';

test('exports only the neutral ACP sandbox extension methods', () => {
  assert.deepEqual(SANDBOX_EXTENSION_METHODS, [
    'sandbox/status',
    'sandbox/preview',
    'sandbox/promote',
    'sandbox/reject',
  ]);
});

function result(stdout = '', stderr = '', exitCode = 0): SubprocessResult {
  return { exitCode, stdout, stderr };
}

function fakeExecutor(respond: (request: SubprocessRequest) => SubprocessResult | Promise<SubprocessResult>): { execute: SubprocessExecutor; calls: SubprocessRequest[] } {
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
  let createdSandboxName: string | undefined;
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
        return result((options.changedFiles ?? []).map(filePath => `${filePath}\n`).join(''));
      }
      if (request.command === 'git' && request.args[0] === 'diff') return result(options.diff ?? '');

      if (request.args.join(' ') === 'version') return result('Docker Sandbox 0.35.0\n');
      if (request.args.join(' ') === 'create --help') return result('Usage: sbx create --clone');
      if (request.args.join(' ') === 'ls --help') return result('Usage: sbx ls --json');
      if (request.args.join(' ') === 'policy init --help') return result('Usage: sbx policy init');
      if (request.args.join(' ') === 'policy ls --json') return result('[{"name":"local-policy"}]\n');
      if (request.args[0] === 'create') {
        createdSandboxName = request.args[request.args.indexOf('--name') + 1];
        return result();
      }
      if (request.args.join(' ') === 'ls --json') {
        return result(createdSandboxName
          ? JSON.stringify([{ id: `id-${createdSandboxName}`, name: createdSandboxName }])
          : '[]');
      }

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

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-sandbox-lifecycle-'));
}

function abortedExecution(request: SubprocessRequest): Promise<SubprocessResult> {
  return new Promise((_resolve, reject) => {
    const rejectAbort = (): void => reject(Object.assign(new Error('subprocess aborted'), { name: 'AbortError' }));
    if (request.signal?.aborted) {
      rejectAbort();
      return;
    }
    request.signal?.addEventListener('abort', rejectAbort, { once: true });
  });
}

test('creates and previews an attributed Agent Checkpoint without mutating the host workspace', async () => {
  const scenario = sandboxScenario({
    changedFiles: ['src/feature.ts', 'README.md'],
    diff: 'diff --git a/src/feature.ts b/src/feature.ts\n+checkpoint change\n',
  });
  const fake = fakeExecutor(scenario.respond);
  const runtime = new DockerSandboxRuntime(fake.execute);
  const states: SandboxRunState[] = [];

  const output = await runtime.runCodex({
    workspaceCwd: '/repo',
    runId: 'Run 42',
    nodeId: 'Implement/API',
    attempt: 2,
    prompt: 'Implement the feature.',
    model: 'gpt-5.6-codex',
    effort: 'high',
    workspaceEffects: true,
    onStateChange: state => { states.push(state); },
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
  assert.deepEqual(states.map(state => [state.integrationState, state.resourceState]), [
    ['sandbox_created', 'active'],
    ['checkpointed', 'active'],
    ['checkpointed', 'removed'],
  ]);
  assert.equal(states[0].baseCommit, 'base123');
  assert.equal(states[0].sandboxId, `id-${sandboxName}`);
  assert.equal(states[1].checkpoint?.checkpoint.commit, 'checkpoint456');
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
  assert.equal(fake.calls.some(call => call.args[0] === 'create' && !call.args.includes('--help')), false);
});

test('ignores Slopify run state created before the clean-workspace preflight', async () => {
  const scenario = sandboxScenario();
  const fake = fakeExecutor(request => {
    if (request.command === 'git' && request.args[0] === 'status') {
      const excludesRuntimeState = request.args.includes(':(exclude).acp/logs')
        && request.args.includes(':(exclude).acp/runs-v3');
      return result(excludesRuntimeState ? '' : '?? .acp/logs/\n?? .acp/runs-v3/\n');
    }
    return scenario.respond(request);
  });

  const output = await new DockerSandboxRuntime(fake.execute).runCodex({
    workspaceCwd: '/repo', runId: 'run', nodeId: 'node', attempt: 1,
    prompt: 'x', model: 'gpt', workspaceEffects: true,
  });

  assert.equal(output.status, 'no_changes');
  assert.equal(fake.calls.some(call => call.args[0] === 'create'), true);
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

test('accepts the installed sbx version output format', async () => {
  const scenario = sandboxScenario();
  const fake = fakeExecutor(request => request.args.join(' ') === 'version'
    ? result('sbx version: v0.35.0 01e01520456e4126a9653471e7072e4d9b280321\n')
    : scenario.respond(request));

  await new DockerSandboxRuntime(fake.execute).preflightWorkspace('/repo');
});

test('rejects an occupied planned sandbox name before creation', async () => {
  const scenario = sandboxScenario();
  const sandboxName = stableSandboxName('run', 'node', 1);
  const fake = fakeExecutor(request => request.args.join(' ') === 'ls --json'
    ? result(JSON.stringify([{ id: 'foreign-id', name: sandboxName }]))
    : scenario.respond(request));

  await assert.rejects(
    new DockerSandboxRuntime(fake.execute).runCodex({
      workspaceCwd: '/repo', runId: 'run', nodeId: 'node', attempt: 1,
      prompt: 'x', model: 'gpt', workspaceEffects: true,
    }),
    /name collision.*cannot be reused without matching persisted state/i,
  );
  assert.equal(fake.calls.some(call => call.args[0] === 'create' && !call.args.includes('--help')), false);
});

test('initializes each Docker global network preset from the exact CLI choices without per-sandbox rules', async t => {
  const cases: Array<[DockerSandboxNetworkPolicyChoice, DockerSandboxNetworkPolicyPreset]> = [
    ['Open', 'allow-all'],
    ['Balanced', 'balanced'],
    ['Locked Down', 'deny-all'],
  ];

  for (const [choice, preset] of cases) {
    await t.test(choice, async () => {
      const baseline = sandboxScenario();
      const fake = fakeExecutor(request => {
        if (request.args.join(' ') === 'policy ls --json') return result('', 'policy is not initialized', 1);
        return baseline.respond(request);
      });
      let offered: readonly DockerSandboxNetworkPolicyChoice[] = [];
      const messages: string[] = [];
      const runtime = new DockerSandboxRuntime(fake.execute, {
        selectNetworkPolicy: choices => {
          offered = [...choices];
          return choice;
        },
        reportNetworkPolicy: message => messages.push(message),
      });

      await runtime.runCodex({
        workspaceCwd: '/repo', runId: `run-${preset}`, nodeId: 'node', attempt: 1,
        prompt: 'Inspect.', model: 'gpt', workspaceEffects: false,
      });

      assert.deepEqual(offered, DOCKER_SANDBOX_NETWORK_POLICY_CHOICES);
      assert.equal(fake.calls.filter(call => call.args.join(' ') === `policy init ${preset}`).length, 1);
      assert.match(messages.join('\n'), new RegExp(`${choice}.*sbx policy`));
      assert.equal(fake.calls.some(call => call.args.includes('--sandbox')), false);
      assert.equal(fake.calls.some(call => call.args[1] === 'allow' || call.args[1] === 'deny'), false);
    });
  }
});

test('reuses an initialized global network policy without prompting again', async () => {
  const fake = fakeExecutor(sandboxScenario().respond);
  let prompts = 0;
  const runtime = new DockerSandboxRuntime(fake.execute, {
    selectNetworkPolicy: () => {
      prompts += 1;
      return 'Balanced';
    },
  });

  await runtime.preflightWorkspace('/repo');
  await runtime.preflightWorkspace('/repo');

  assert.equal(prompts, 0);
  assert.equal(fake.calls.filter(call => call.args.join(' ') === 'policy ls --json').length, 1);
  assert.equal(fake.calls.some(call => call.args[0] === 'policy' && call.args[1] === 'init' && call.args[2] !== '--help'), false);
});

test('cancelling one preflight does not abort global policy initialization shared with another run', async () => {
  const baseline = sandboxScenario();
  let announceInitializationStarted: (() => void) | undefined;
  const initializationStarted = new Promise<void>(resolve => { announceInitializationStarted = resolve; });
  let finishInitialization: ((value: SubprocessResult) => void) | undefined;
  const initialization = new Promise<SubprocessResult>(resolve => { finishInitialization = resolve; });
  const fake = fakeExecutor(request => {
    if (request.args.join(' ') === 'policy ls --json') return result('', 'policy is not initialized', 1);
    if (request.args.join(' ') === 'policy init balanced') {
      announceInitializationStarted?.();
      return initialization;
    }
    return baseline.respond(request);
  });
  const runtime = new DockerSandboxRuntime(fake.execute, {
    selectNetworkPolicy: () => 'Balanced',
  });
  const cancelled = new AbortController();

  const firstPreflight = runtime.preflightWorkspace('/repo', true, cancelled.signal);
  await initializationStarted;
  const secondPreflight = runtime.preflightWorkspace('/repo');
  cancelled.abort();

  await assert.rejects(firstPreflight, error => error instanceof Error && error.name === 'AbortError');
  finishInitialization?.(result());
  await secondPreflight;

  assert.equal(fake.calls.filter(call => call.args.join(' ') === 'policy ls --json').length, 1);
  const initCalls = fake.calls.filter(call => call.args.join(' ') === 'policy init balanced');
  assert.equal(initCalls.length, 1);
  assert.equal(initCalls[0].signal?.aborted, false);
});

test('cancelling the last preflight aborts its global policy subprocess', async () => {
  const baseline = sandboxScenario();
  let announceInitializationStarted: (() => void) | undefined;
  const initializationStarted = new Promise<void>(resolve => { announceInitializationStarted = resolve; });
  let initializationSignal: AbortSignal | undefined;
  const fake = fakeExecutor(request => {
    if (request.args.join(' ') === 'policy ls --json') return result('', 'policy is not initialized', 1);
    if (request.args.join(' ') === 'policy init balanced') {
      initializationSignal = request.signal;
      announceInitializationStarted?.();
      return abortedExecution(request);
    }
    return baseline.respond(request);
  });
  const runtime = new DockerSandboxRuntime(fake.execute, {
    selectNetworkPolicy: () => 'Balanced',
  });
  const cancelled = new AbortController();

  const preflight = runtime.preflightWorkspace('/repo', true, cancelled.signal);
  await initializationStarted;
  cancelled.abort();

  await assert.rejects(preflight, error => error instanceof Error && error.name === 'AbortError');
  assert.equal(initializationSignal?.aborted, true);
});

test('fails before sandbox creation when global network policy initialization fails', async () => {
  const baseline = sandboxScenario();
  const fake = fakeExecutor(request => {
    if (request.args.join(' ') === 'policy ls --json') return result('', 'policy is not initialized', 1);
    if (request.args.join(' ') === 'policy init balanced') return result('', 'daemon refused policy', 7);
    return baseline.respond(request);
  });
  const runtime = new DockerSandboxRuntime(fake.execute, {
    selectNetworkPolicy: () => 'Balanced',
  });

  await assert.rejects(
    runtime.runCodex({ workspaceCwd: '/repo', runId: 'run', nodeId: 'node', attempt: 1, prompt: 'x', model: 'gpt' }),
    /Unable to initialize the Docker Sandbox global network policy as Balanced: daemon refused policy/,
  );
  assert.equal(fake.calls.some(call => call.args[0] === 'create' && !call.args.includes('--help')), false);
});

test('fails with corrective guidance when policy initialization needs a non-interactive choice', async () => {
  const baseline = sandboxScenario();
  const fake = fakeExecutor(request => request.args.join(' ') === 'policy ls --json'
    ? result('', 'policy is not initialized', 1)
    : baseline.respond(request));

  await assert.rejects(
    new DockerSandboxRuntime(fake.execute).preflightWorkspace('/repo'),
    /Choose Open, Balanced or Locked Down.*sbx policy init/,
  );
});

test('cleans the sandbox when Codex fails', async () => {
  const scenario = sandboxScenario();
  const fake = fakeExecutor(request => request.args[0] === 'exec' && request.args.includes('codex')
    ? result('', 'codex failed', 7)
    : scenario.respond(request));
  await assert.rejects(new DockerSandboxRuntime(fake.execute).runCodex({ workspaceCwd: '/repo', runId: 'run', nodeId: 'node', attempt: 1, prompt: 'x', model: 'gpt' }), /codex failed/);
  assert.deepEqual(fake.calls.at(-1)?.args.slice(0, 2), ['rm', '--force']);
});

test('an already absent sandbox does not turn successful cleanup into a pipeline failure', async () => {
  const cwd = temporaryDirectory();
  try {
    const diagnosticsDirectory = path.join(cwd, '.acp', 'logs', 'sandboxes');
    const sandboxName = stableSandboxName('run', 'node', 1);
    const diagnosticPath = path.join(diagnosticsDirectory, `${sandboxName}.json`);
    const scenario = sandboxScenario();
    const fake = fakeExecutor(request => {
      if (request.args[0] === 'rm') {
        assert.equal(fs.existsSync(diagnosticPath), true, 'diagnostics must exist before cleanup');
        return result('', `sandbox ${sandboxName} not found`, 1);
      }
      return scenario.respond(request);
    });

    const output = await new DockerSandboxRuntime(fake.execute).runCodex({
      workspaceCwd: cwd, runId: 'run', nodeId: 'node', attempt: 1,
      prompt: 'inspect', model: 'gpt', diagnosticsDirectory,
    });

    assert.equal(output.status, 'no_changes');
    const diagnostic = JSON.parse(fs.readFileSync(diagnosticPath, 'utf8')) as { cleanup: { exitCode: number }; status: string };
    assert.equal(diagnostic.status, 'completed');
    assert.equal(diagnostic.cleanup.exitCode, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('external cancellation aborts the active sbx exec process and still cleans the sandbox', async () => {
  const controller = new AbortController();
  let started: (() => void) | undefined;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  let codexSignal: AbortSignal | undefined;
  const scenario = sandboxScenario();
  const fake = fakeExecutor(request => {
    if (request.args[0] === 'exec' && request.args.includes('codex')) {
      codexSignal = request.signal;
      started?.();
      return abortedExecution(request);
    }
    return scenario.respond(request);
  });

  const running = new DockerSandboxRuntime(fake.execute).runCodex({
    workspaceCwd: '/repo', runId: 'run', nodeId: 'cancelled', attempt: 1,
    prompt: 'work', model: 'gpt', signal: controller.signal,
  });
  await startedPromise;
  controller.abort();

  await assert.rejects(running, SandboxRunCancelledError);
  assert.equal(codexSignal?.aborted, true);
  assert.deepEqual(fake.calls.at(-1)?.args.slice(0, 2), ['rm', '--force']);
});

test('timeout aborts the active sbx exec process and exports a timed_out diagnostic', async () => {
  const cwd = temporaryDirectory();
  try {
    const diagnosticsDirectory = path.join(cwd, '.acp', 'logs', 'sandboxes');
    let codexSignal: AbortSignal | undefined;
    const scenario = sandboxScenario();
    const fake = fakeExecutor(request => {
      if (request.args[0] === 'exec' && request.args.includes('codex')) {
        codexSignal = request.signal;
        return abortedExecution(request);
      }
      return scenario.respond(request);
    });

    await assert.rejects(
      new DockerSandboxRuntime(fake.execute).runCodex({
        workspaceCwd: cwd, runId: 'run', nodeId: 'timeout', attempt: 1,
        prompt: 'work', model: 'gpt', timeoutMs: 10, diagnosticsDirectory,
      }),
      SandboxRunTimeoutError,
    );

    assert.equal(codexSignal?.aborted, true);
    assert.deepEqual(fake.calls.at(-1)?.args.slice(0, 2), ['rm', '--force']);
    const sandboxName = stableSandboxName('run', 'timeout', 1);
    const diagnostic = JSON.parse(fs.readFileSync(path.join(diagnosticsDirectory, `${sandboxName}.json`), 'utf8')) as { status: string };
    assert.equal(diagnostic.status, 'timed_out');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a hung cleanup is aborted on its own deadline and recorded without blocking the run', async () => {
  const cwd = temporaryDirectory();
  try {
    const diagnosticsDirectory = path.join(cwd, '.acp', 'logs', 'sandboxes');
    let cleanupSignal: AbortSignal | undefined;
    const scenario = sandboxScenario();
    const fake = fakeExecutor(request => {
      if (request.args[0] === 'rm') {
        cleanupSignal = request.signal;
        return abortedExecution(request);
      }
      return scenario.respond(request);
    });

    const output = await new DockerSandboxRuntime(fake.execute, 10).runCodex({
      workspaceCwd: cwd,
      runId: 'run',
      nodeId: 'cleanup-timeout',
      attempt: 1,
      prompt: 'work',
      model: 'gpt',
      diagnosticsDirectory,
    });

    assert.equal(output.status, 'no_changes');
    assert.equal(cleanupSignal?.aborted, true);
    const sandboxName = stableSandboxName('run', 'cleanup-timeout', 1);
    const diagnostic = JSON.parse(fs.readFileSync(path.join(diagnosticsDirectory, `${sandboxName}.json`), 'utf8')) as {
      cleanup: { attempted: boolean; timedOut: boolean; error: string };
    };
    assert.deepEqual(diagnostic.cleanup, {
      attempted: true,
      timedOut: true,
      error: 'Sandbox cleanup timed out after 10 ms.',
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('keepSandbox preserves resources and reports copyable commands after success and failure', async t => {
  const cases: Array<{ name: string; fail: boolean }> = [
    { name: 'success', fail: false },
    { name: 'failure', fail: true },
  ];

  for (const current of cases) {
    await t.test(current.name, async () => {
      const cwd = temporaryDirectory();
      try {
        const retained: RetainedSandbox[] = [];
        const scenario = sandboxScenario();
        const fake = fakeExecutor(request => current.fail && request.args[0] === 'exec' && request.args.includes('codex')
          ? result('', 'codex failed', 7)
          : scenario.respond(request));
        const run = new DockerSandboxRuntime(fake.execute).runCodex({
          workspaceCwd: cwd,
          runId: 'run',
          nodeId: current.name,
          attempt: 1,
          prompt: 'work',
          model: 'gpt',
          keepSandbox: true,
          diagnosticsDirectory: path.join(cwd, '.acp', 'logs', 'sandboxes'),
          onSandboxRetained: sandbox => { retained.push(sandbox); },
        });

        if (current.fail) await assert.rejects(run, /codex failed/);
        else await run;

        const sandboxName = stableSandboxName('run', current.name, 1);
        assert.deepEqual(retained, [{
          sandboxName,
          commands: retainedSandboxCommands(sandboxName),
          diagnosticsPath: path.join(cwd, '.acp', 'logs', 'sandboxes', `${sandboxName}.json`),
        }]);
        assert.equal(fake.calls.some(call => call.args[0] === 'rm'), false);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
});

test('reconciles a persisted sandbox only when its stable identity and checkpoint base match', async () => {
  const fake = fakeExecutor(request => {
    if (request.args.join(' ') === 'ls --json') {
      return result(JSON.stringify([{ id: 'sandbox-id-42', name: 'slopify-run-node-1-deadbeef' }]));
    }
    if (request.args.join(' ') === 'exec slopify-run-node-1-deadbeef git rev-parse HEAD') {
      return result('checkpoint456\n');
    }
    if (request.args.join(' ') === 'exec slopify-run-node-1-deadbeef git merge-base --is-ancestor base123 checkpoint456') {
      return result();
    }
    if (request.args.join(' ') === 'exec slopify-run-node-1-deadbeef git status --porcelain=v1') return result();
    return result('', `unexpected ${request.args.join(' ')}`, 1);
  });

  const reconciled = await new DockerSandboxRuntime(fake.execute).reconcileSandbox({
    workspaceCwd: '/repo',
    sandboxName: 'slopify-run-node-1-deadbeef',
    sandboxId: 'sandbox-id-42',
    baseCommit: 'base123',
    checkpointCommit: 'checkpoint456',
  });

  assert.deepEqual(reconciled, {
    status: 'reusable',
    sandboxName: 'slopify-run-node-1-deadbeef',
    sandboxId: 'sandbox-id-42',
    observedCommit: 'checkpoint456',
  });
  assert.equal(fake.calls.some(call => call.args[0] === 'create' && !call.args.includes('--help')), false);
  assert.equal(fake.calls.some(call => call.args[0] === 'rm'), false);
});

test('resumes a matching sandbox after creation without creating a second resource', async () => {
  const sandboxName = stableSandboxName('run-resume', 'work', 1);
  const scenario = sandboxScenario({ changedFiles: ['work.ts'], diff: 'diff' });
  const fake = fakeExecutor(request => {
    if (request.args.join(' ') === 'ls --json') return result(JSON.stringify([{ id: 'stable-id', name: sandboxName }]));
    if (request.command === 'sbx' && request.args.join(' ') === `exec ${sandboxName} git rev-parse HEAD`) return result('base123\n');
    return scenario.respond(request);
  });

  const output = await new DockerSandboxRuntime(fake.execute).runCodex({
    workspaceCwd: '/repo', runId: 'run-resume', nodeId: 'work', attempt: 1,
    prompt: 'Continue safely.', model: 'gpt',
    resumeState: {
      sandboxName, sandboxId: 'stable-id', runId: 'run-resume', nodeId: 'work', attempt: 1,
      baseCommit: 'base123', integrationState: 'sandbox_created', resourceState: 'active',
    },
  });

  assert.equal(output.checkpoint.commit, 'checkpoint456');
  assert.equal(fake.calls.some(call => call.args[0] === 'create' && !call.args.includes('--help')), false);
  assert.equal(fake.calls.some(call => call.args[0] === 'exec' && call.args.includes('codex')), true);
});

test('resumes after checkpoint persistence without relaunching Codex or requiring the removed resource', async () => {
  const sandboxName = stableSandboxName('run-checkpointed', 'work', 1);
  const scenario = sandboxScenario({ changedFiles: ['work.ts'], diff: 'diff' });
  const fake = fakeExecutor(scenario.respond);

  const output = await new DockerSandboxRuntime(fake.execute).runCodex({
    workspaceCwd: '/repo', runId: 'run-checkpointed', nodeId: 'work', attempt: 1,
    prompt: 'Do not run again.', model: 'gpt',
    resumeState: {
      sandboxName, sandboxId: 'stable-id', runId: 'run-checkpointed', nodeId: 'work', attempt: 1,
      baseCommit: 'base123', integrationState: 'checkpointed', resourceState: 'removed',
      stdout: 'persisted output', stderr: '',
      checkpoint: {
        checkpointStatus: 'checkpointed',
        checkpoint: {
          sandboxName, runId: 'run-checkpointed', nodeId: 'work', attempt: 1,
          baseCommit: 'base123', commit: 'checkpoint456',
          remote: `sandbox-${sandboxName}`, ref: `refs/slopify/checkpoints/${sandboxName}`,
        },
        preview: {
          baseCommit: 'base123', checkpointCommit: 'checkpoint456', fileCount: 1,
          files: ['work.ts'], diff: 'diff',
        },
      },
    },
  });

  assert.equal(output.checkpoint.commit, 'checkpoint456');
  assert.equal(output.stdout, 'persisted output');
  assert.equal(fake.calls.some(call => call.args.join(' ') === 'ls --json'), false);
  assert.equal(fake.calls.some(call => call.args[0] === 'exec' && call.args.includes('codex')), false);
  assert.equal(fake.calls.some(call => call.args[0] === 'rm'), false);
});

test('repeats cleanup idempotently when a checkpointed sandbox disappeared before removed state persisted', async () => {
  const sandboxName = stableSandboxName('run-cleanup-crash', 'work', 1);
  const scenario = sandboxScenario();
  const fake = fakeExecutor(request => {
    if (request.args.join(' ') === 'ls --json') return result('[]');
    return scenario.respond(request);
  });

  const output = await new DockerSandboxRuntime(fake.execute).runCodex({
    workspaceCwd: '/repo', runId: 'run-cleanup-crash', nodeId: 'work', attempt: 1,
    prompt: 'Do not run again.', model: 'gpt',
    resumeState: {
      sandboxName, sandboxId: 'stable-id', runId: 'run-cleanup-crash', nodeId: 'work', attempt: 1,
      baseCommit: 'base123', integrationState: 'checkpointed', resourceState: 'active',
      checkpoint: {
        checkpointStatus: 'checkpointed',
        checkpoint: {
          sandboxName, runId: 'run-cleanup-crash', nodeId: 'work', attempt: 1,
          baseCommit: 'base123', commit: 'checkpoint456', remote: `sandbox-${sandboxName}`,
          ref: `refs/slopify/checkpoints/${sandboxName}`,
        },
        preview: { baseCommit: 'base123', checkpointCommit: 'checkpoint456', fileCount: 1, files: ['work.ts'], diff: 'diff' },
      },
    },
  });

  assert.equal(output.checkpoint.commit, 'checkpoint456');
  assert.equal(fake.calls.some(call => call.args[0] === 'exec' && call.args.includes('codex')), false);
  assert.equal(fake.calls.some(call => call.args[0] === 'rm'), false);
});

test('suspends an uncheckpointed sandbox with partial worktree changes', async () => {
  const fake = fakeExecutor(request => {
    if (request.args.join(' ') === 'ls --json') return result(JSON.stringify([{ id: 'stable-id', name: 'sandbox-work' }]));
    if (request.args.join(' ') === 'exec sandbox-work git rev-parse HEAD') return result('base123\n');
    if (request.args.join(' ') === 'exec sandbox-work git status --porcelain=v1') return result(' M src/work.ts\n');
    return result();
  });

  const reconciled = await new DockerSandboxRuntime(fake.execute).reconcileSandbox({
    workspaceCwd: '/repo', sandboxName: 'sandbox-work', sandboxId: 'stable-id', baseCommit: 'base123',
  });

  assert.equal(reconciled.status, 'diverged');
  assert.match(reconciled.status === 'diverged' ? reconciled.diagnostic : '', /worktree.*uncheckpointed/i);
});

test('suspends reconciliation on identity or base divergence without relaunch, cleanup, or Promotion', async t => {
  const cases = [
    {
      name: 'identity',
      listing: [{ id: 'foreign-id', name: 'slopify-run-node-1-deadbeef' }],
      head: 'base123',
      expected: /identity.*foreign-id.*sandbox-id-42/i,
    },
    {
      name: 'base',
      listing: [{ id: 'sandbox-id-42', name: 'slopify-run-node-1-deadbeef' }],
      head: 'foreign-head',
      expected: /base.*base123.*foreign-head/i,
    },
  ] as const;

  for (const current of cases) {
    await t.test(current.name, async () => {
      const fake = fakeExecutor(request => {
        if (request.args.join(' ') === 'ls --json') return result(JSON.stringify(current.listing));
        if (request.args[0] === 'exec' && request.args.includes('rev-parse')) return result(`${current.head}\n`);
        if (request.args[0] === 'exec' && request.args.includes('merge-base')) return result('', 'not an ancestor', 1);
        return result();
      });

      const reconciled = await new DockerSandboxRuntime(fake.execute).reconcileSandbox({
        workspaceCwd: '/repo',
        sandboxName: 'slopify-run-node-1-deadbeef',
        sandboxId: 'sandbox-id-42',
        baseCommit: 'base123',
      });

      assert.equal(reconciled.status, 'diverged');
      assert.match(reconciled.diagnostic, current.expected);
      assert.equal(fake.calls.some(call => ['create', 'rm', 'run'].includes(call.args[0] ?? '')), false);
      assert.deepEqual(hostMutatingGitCalls(fake.calls), []);
    });
  }
});
