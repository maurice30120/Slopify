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
  write(): void {}
  writeError(message: string): void { this.errors.push(message); }
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
    verbose: true,
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
    verbose: true,
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
