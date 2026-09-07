import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  PipelineIntegrationConflictError,
  compilePipelineV3Definition,
  type CompiledPipelineProgram,
  type PipelineAgentRunInput,
  type PipelineAgentRunner,
} from '@acp-client/pipeline';

import { CliPipelineHost, type CliPipelineBackendFactory } from '../src/host.js';
import type { CliTerminal } from '../src/terminal.js';

class FakeTerminal implements CliTerminal {
  readonly errors: string[] = [];
  readonly rawErrors: string[] = [];
  readonly supportsAnsi: boolean;
  readonly columns = 80;
  constructor(supportsAnsi = false) {
    this.supportsAnsi = supportsAnsi;
  }
  write(): void {}
  writeError(message: string): void { this.errors.push(message); }
  writeErrorRaw(message: string): void { this.rawErrors.push(message); }
  async ask(): Promise<string> { return ''; }
  async confirm(): Promise<boolean> { return false; }
  async select(): Promise<string | undefined> { return undefined; }
  close(): void {}
}

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acp-cli-v3-'));
}

function program(): CompiledPipelineProgram {
  const result = compilePipelineV3Definition({
    version: 3,
    id: 'question-flow',
    title: 'Question Flow',
    nodes: [
      {
        id: 'plan',
        agent: 'Planner',
        skills: ['grill-me'],
        prompt: 'Plan {{userPrompt}}',
        output: { name: 'plan', type: 'acp.plan/v1', format: 'markdown' },
      },
      {
        id: 'question',
        type: 'pause',
        pause: 'question',
        content: '{{inputs.plan}}',
        format: 'markdown',
        needs: ['plan'],
        inputs: [{ name: 'plan', from: 'plan.plan', type: 'acp.plan/v1', format: 'markdown' }],
        output: { name: 'answer', type: 'acp.answer/v1', format: 'markdown' },
      },
    ],
  }, { Planner: {} });
  assert.deepEqual(result.errors, []);
  assert.ok(result.program);
  return result.program;
}

function backend(runner?: PipelineAgentRunner, clearRunLogs?: () => void): CliPipelineBackendFactory {
  const pipeline = program();
  return () => ({ programs: [pipeline], runAgent: runner, clearRunLogs });
}

test('runs an injected backend and forwards agent metadata', async () => {
  const calls: PipelineAgentRunInput[] = [];
  const runner: PipelineAgentRunner = async input => {
    calls.push(input);
    return { text: 'Which API?' };
  };
  const host = new CliPipelineHost(workspace(), {
    terminal: new FakeTerminal(),
    backendFactory: backend(runner),
    runIdFactory: () => 'run-test',
  });

  const started = await host.start('question-flow', 'add a CLI');
  assert.equal(started.status, 'paused');
  assert.equal(calls[0]?.agentName, 'Planner');
  assert.deepEqual(calls[0]?.skills, ['grill-me']);

  if (started.status !== 'paused') assert.fail('Expected a question pause.');
  const completed = await host.resume(started.runId, {
    pauseId: started.pause.id,
    kind: 'answer',
    value: 'Use PipelineRuntime',
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.status === 'completed' ? completed.artifact?.value : '', 'Use PipelineRuntime');
});

test('resumes a persisted pipeline pause after the CLI host is reconstructed', async () => {
  const cwd = workspace();
  const runner: PipelineAgentRunner = async () => ({ text: 'Which API?' });
  const firstHost = new CliPipelineHost(cwd, {
    terminal: new FakeTerminal(),
    backendFactory: backend(runner),
    runIdFactory: () => 'run-after-crash',
  });
  const paused = await firstHost.start('question-flow', 'add a CLI');
  assert.equal(paused.status, 'paused');

  const restoredHost = new CliPipelineHost(cwd, {
    terminal: new FakeTerminal(),
    backendFactory: backend(runner),
  });
  const completed = await restoredHost.resume('run-after-crash', {
    pauseId: paused.status === 'paused' ? paused.pause.id : 'unreachable',
    kind: 'answer',
    value: 'Use the persisted snapshot',
  });

  assert.equal(completed.status, 'completed');
  assert.equal(completed.status === 'completed' ? completed.artifact?.value : '', 'Use the persisted snapshot');
});

test('surfaces an Integration Conflict and retries its node through the CLI host', async () => {
  const attempts: number[] = [];
  let finalizations = 0;
  const runner: PipelineAgentRunner = async input => {
    attempts.push(input.attempt ?? 0);
    return { text: 'Which API?' };
  };
  runner.finalizePipelineChangeSet = async input => {
    finalizations += 1;
    if (finalizations === 1) {
      throw new PipelineIntegrationConflictError({
        runId: input.runId,
        retryNodeId: 'plan',
        checkpoints: [
          { nodeId: 'plan', attempt: 1, commit: 'plan-1', ref: 'refs/checkpoints/plan-1' },
        ],
        files: ['src/shared.ts'],
      });
    }
    return {
      promotion: 'no_changes',
      preview: {
        baseCommit: 'base',
        changeSetCommit: 'base',
        fileCount: 0,
        files: [],
        diff: '',
      },
      integratedNodeIds: ['plan'],
    };
  };
  const host = new CliPipelineHost(workspace(), {
    terminal: new FakeTerminal(),
    backendFactory: backend(runner),
    runIdFactory: () => 'run-cli-integration-conflict',
  });

  const question = await host.start('question-flow', 'add a CLI');
  assert.equal(question.status, 'paused');
  const conflict = await host.resume(question.runId, {
    pauseId: question.status === 'paused' ? question.pause.id : 'unreachable',
    kind: 'answer',
    value: 'Use PipelineRuntime',
  });
  assert.equal(conflict.status, 'paused');
  assert.equal(conflict.snapshot.pendingPause?.integrationConflict?.retryNodeId, 'plan');

  const completed = await host.resume(conflict.runId, {
    pauseId: conflict.status === 'paused' ? conflict.pause.id : 'unreachable',
    kind: 'approve',
  });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(finalizations, 2);
});

test('passes workspace services to the backend factory', () => {
  const cwd = workspace();
  const terminal = new FakeTerminal();
  let actualCwd = '';
  let actualTerminal: Pick<CliTerminal, 'confirm' | 'select'> | undefined;
  const host = new CliPipelineHost(cwd, {
    terminal,
    logLevel: 'verbose',
    backendFactory: (workspaceCwd, context) => {
      actualCwd = workspaceCwd;
      actualTerminal = context.terminal;
      context.logger.log('backend ready');
      return { programs: [program()], runAgent: async () => ({ text: '' }) };
    },
  });
  assert.equal(actualCwd, cwd);
  assert.equal(actualTerminal, terminal);
  assert.ok(terminal.errors.includes('[slopify] backend ready'));
  assert.equal(host.listPipelines()[0]?.id, 'question-flow');
});

test('preflights a workspace-writing pipeline before creating run artifacts', async () => {
  const cwd = workspace();
  let runnerCalls = 0;
  const host = new CliPipelineHost(cwd, {
    terminal: new FakeTerminal(),
    backendFactory: (() => ({
      programs: [program()],
      preflightPipeline: async () => { throw new Error('workspace preflight failed'); },
      runAgent: async () => {
        runnerCalls += 1;
        return { text: 'must not run' };
      },
    })) as CliPipelineBackendFactory,
    runIdFactory: () => 'run-preflight',
  });

  await assert.rejects(() => host.start('question-flow', 'add a CLI'), /workspace preflight failed/);
  assert.equal(runnerCalls, 0);
  assert.equal(fs.existsSync(path.join(cwd, '.acp', 'logs')), false);
  assert.equal(fs.existsSync(path.join(cwd, '.acp', 'runs-v3')), false);
});

test('requires a runner from the host or backend', () => {
  assert.throws(
    () => new CliPipelineHost(workspace(), {
      terminal: new FakeTerminal(),
      backendFactory: () => ({ programs: [program()] }),
    }),
    /must provide runAgent/,
  );
});

test('logs agent failures with RPC details', async () => {
  const terminal = new FakeTerminal();
  const runner: PipelineAgentRunner = async () => {
    throw Object.assign(new Error('Internal error'), {
      code: -32603,
      data: { details: 'provider rejected the request' },
    });
  };
  const host = new CliPipelineHost(workspace(), {
    terminal,
    logLevel: 'verbose',
    backendFactory: backend(runner),
  });
  const result = await host.start('question-flow', 'add a CLI');
  assert.equal(result.status, 'failed');
  assert.ok(terminal.errors.includes(
    '[slopify] Agent "Planner" failed: Internal error; code=-32603; data={"details":"provider rejected the request"}',
  ));
});

test('clears run logs through the backend hook', async () => {
  const cwd = workspace();
  const logsDir = path.join(cwd, '.acp', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, 'stale.jsonl'), '{}\n');
  let cleanupCalls = 0;
  const host = new CliPipelineHost(cwd, {
    terminal: new FakeTerminal(),
    backendFactory: backend(async () => ({ text: 'Which API?' }), () => { cleanupCalls += 1; }),
    runIdFactory: () => 'run-log-test',
  });
  const result = await host.start('question-flow', 'add a CLI');
  assert.equal(result.status, 'paused');
  assert.equal(cleanupCalls, 1);
  const files = fs.readdirSync(logsDir);
  assert.equal(files.length, 2);
  assert.ok(!files.includes('stale.jsonl'));
});

test('rejects resume and cancel for unknown runs', async () => {
  const host = new CliPipelineHost(workspace(), {
    terminal: new FakeTerminal(),
    backendFactory: backend(async () => ({ text: '' })),
  });
  await assert.rejects(
    () => host.resume('missing-run', { pauseId: 'pause-1', kind: 'reject' }),
    /Unknown active ACP pipeline run "missing-run"/,
  );
  await assert.rejects(() => host.cancel('missing-run'), /Unknown active ACP pipeline run "missing-run"/);
});

test('renders node transitions in default log level', async () => {
  const terminal = new FakeTerminal();
  const runner: PipelineAgentRunner = async () => ({ text: 'Which API?' });
  const host = new CliPipelineHost(workspace(), {
    terminal,
    backendFactory: backend(runner),
    runIdFactory: () => 'run-transitions',
  });
  const result = await host.start('question-flow', 'add a CLI');
  assert.equal(result.status, 'paused');
  const joined = terminal.errors.join('\n');
  assert.match(joined, /▶ plan · Planner/);
  assert.match(joined, /✓ plan · Planner · \d+/);
});

test('suppresses status output in quiet log level', async () => {
  const terminal = new FakeTerminal();
  const runner: PipelineAgentRunner = async () => ({ text: 'Which API?' });
  const host = new CliPipelineHost(workspace(), {
    terminal,
    backendFactory: backend(runner),
    logLevel: 'quiet',
    runIdFactory: () => 'run-quiet',
  });
  const result = await host.start('question-flow', 'add a CLI');
  assert.equal(result.status, 'paused');
  assert.equal(terminal.errors.length, 0);
});

test('streams agent thought and message chunks live at verbose level', async () => {
  const terminal = new FakeTerminal();
  const runner: PipelineAgentRunner = async input => {
    input.onSessionUpdate?.({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Analyzing... ' } },
    });
    input.onSessionUpdate?.({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'the request.' } },
    });
    input.onSessionUpdate?.({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Which API?' } },
    });
    return { text: 'Which API?' };
  };
  const host = new CliPipelineHost(workspace(), {
    terminal,
    logLevel: 'verbose',
    backendFactory: backend(runner),
    runIdFactory: () => 'run-stream',
  });

  const started = await host.start('question-flow', 'add a CLI');
  assert.equal(started.status, 'paused');
  assert.ok(
    terminal.errors.includes('[slopify] plan · Planner réfléchit'),
    'thought phase label streamed',
  );
  assert.ok(
    terminal.errors.includes('[slopify] plan · Planner répond'),
    'message phase label streamed',
  );
  assert.equal(
    terminal.rawErrors.join(''),
    'Analyzing... the request.\nWhich API?\n',
    'thought then message content streamed with newline separators',
  );
});

test('does not stream session content at default log level', async () => {
  const terminal = new FakeTerminal();
  const runner: PipelineAgentRunner = async input => {
    input.onSessionUpdate?.({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'secret' } },
    });
    input.onSessionUpdate?.({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
    });
    return { text: 'Which API?' };
  };
  const host = new CliPipelineHost(workspace(), {
    terminal,
    backendFactory: backend(runner),
    runIdFactory: () => 'run-no-stream',
  });

  const started = await host.start('question-flow', 'add a CLI');
  assert.equal(started.status, 'paused');
  assert.equal(terminal.rawErrors.length, 0, 'no content streamed at default level');
  assert.ok(!terminal.errors.some(e => e.includes('réfléchit') || e.includes('répond')));
});

test('renders streamed markdown as ANSI when terminal supports it', async () => {
  const previousAnsiStream = process.env.SLOPIFY_ANSI_STREAM;
  delete process.env.SLOPIFY_ANSI_STREAM;
  try {
  const terminal = new FakeTerminal(true);
  const runner: PipelineAgentRunner = async input => {
    input.onSessionUpdate?.({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '# Title\n\n**bold** text.' } },
    });
    return { text: 'done' };
  };
  const host = new CliPipelineHost(workspace(), {
    terminal,
    logLevel: 'verbose',
    backendFactory: backend(runner),
    runIdFactory: () => 'run-ansi',
  });

  const started = await host.start('question-flow', 'add a CLI');
  assert.equal(started.status, 'paused');
  const output = terminal.rawErrors.join('');
  assert.ok(output.includes('\x1b['), 'output contains ANSI escape sequences');
  assert.ok(!output.includes('**bold**'), 'markdown bold syntax is rendered, not raw');
  assert.ok(!output.includes('# Title'), 'markdown heading syntax is rendered, not raw');
  assert.ok(output.includes('Title'), 'heading text content is present');
  assert.ok(output.includes('bold'), 'bold text content is present');
  } finally {
    if (previousAnsiStream === undefined) delete process.env.SLOPIFY_ANSI_STREAM;
    else process.env.SLOPIFY_ANSI_STREAM = previousAnsiStream;
  }
});
