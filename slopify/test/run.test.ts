import assert from 'node:assert/strict';
import test from 'node:test';

import type { PipelineRuntimeResult } from '@acp-client/pipeline';

import type { CliResumeCommand, CliRunCommand } from '../src/args.js';
import { formatPipelineList, runPipelineInteractive } from '../src/run.js';
import type { CliTerminal } from '../src/terminal.js';
import type { CliPipelineListEntry } from '../src/host.js';

class FakeTerminal implements CliTerminal {
  readonly output: string[] = [];
  readonly errors: string[] = [];
  readonly answers: string[] = [];
  readonly questions: string[] = [];
  readonly confirmations: boolean[] = [];

  write(message: string): void { this.output.push(message); }
  writeError(message: string): void { this.errors.push(message); }
  async ask(question: string): Promise<string> {
    this.questions.push(question);
    return this.answers.shift() ?? '';
  }
  async confirm(): Promise<boolean> { return this.confirmations.shift() ?? false; }
  async select(): Promise<string | undefined> { return undefined; }
  close(): void {}
}

function command(overrides: Partial<CliRunCommand> = {}): CliRunCommand {
  return {
    kind: 'run',
    pipelineName: 'grill',
    prompt: 'build it',
    cwd: '/repo',
    json: false,
    verbose: false,
    yes: false,
    ...overrides,
  };
}

function snapshot(status: 'paused' | 'completed' | 'cancelled' | 'failed') {
  return {
    runId: 'run-1',
    pipelineId: 'grill',
    status,
    nodeStates: {},
    artifacts: {},
    diagnostics: [],
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
  };
}

test('answers a v3 question then approves the next pause', async () => {
  const terminal = new FakeTerminal();
  terminal.answers.push('Use the public API');
  terminal.confirmations.push(true);
  const resumes: unknown[] = [];
  const results: PipelineRuntimeResult[] = [
    {
      status: 'paused', runId: 'run-1',
      pause: { id: 'q1', nodeId: 'question', type: 'question', content: 'Which API?', recommendation: 'Use the public API.', format: 'markdown' },
      snapshot: snapshot('paused'),
    },
    {
      status: 'paused', runId: 'run-1',
      pause: { id: 'a1', nodeId: 'approval', type: 'approval', content: 'Final plan', format: 'proposed-plan' },
      snapshot: snapshot('paused'),
    },
    {
      status: 'completed', runId: 'run-1',
      artifact: { name: 'result', type: 'text', format: 'markdown', value: 'done', producerNodeId: 'finish' },
      snapshot: snapshot('completed'),
    },
  ];
  const host = {
    start: async () => results.shift()!,
    resume: async (_runId: string, decision: unknown) => {
      resumes.push(decision);
      return results.shift()!;
    },
  };

  const result = await runPipelineInteractive(host, terminal, command());

  assert.equal(result.status, 'completed');
  assert.deepEqual(resumes, [
    { pauseId: 'q1', kind: 'answer', value: 'Use the public API' },
    { pauseId: 'a1', kind: 'approve', value: 'Final plan' },
  ]);
  assert.deepEqual(terminal.questions, ['Answer [/done to finish]:']);
  assert.equal(terminal.output[0], '\n## Pipeline question\n\nWhich API?\n\nRecommended answer\n\nUse the public API.\n');
  assert.equal(terminal.output.at(-1), 'done');
});

test('recovers a persisted running pipeline instead of starting a new one', async () => {
  const terminal = new FakeTerminal();
  let starts = 0;
  let recoveries = 0;
  const host = {
    start: async (): Promise<PipelineRuntimeResult> => {
      starts += 1;
      throw new Error('must not start');
    },
    recover: async (runId: string): Promise<PipelineRuntimeResult> => {
      recoveries += 1;
      return {
        status: 'completed', runId,
        artifact: { name: 'out', type: 'note', format: 'text', value: 'recovered', producerNodeId: 'work' },
        snapshot: { ...snapshot('completed'), runId, inputVariables: { userPrompt: 'original prompt' } },
      };
    },
    resume: async (): Promise<PipelineRuntimeResult> => { throw new Error('must not resume'); },
  };
  const resumeCommand: CliResumeCommand = {
    kind: 'resume', runId: 'run-42', cwd: '/repo', json: false, verbose: false, yes: false,
  };

  const result = await runPipelineInteractive(host, terminal, resumeCommand);

  assert.equal(result.status, 'completed');
  assert.equal(starts, 0);
  assert.equal(recoveries, 1);
  assert.equal(terminal.output.at(-1), 'recovered');
});

test('translates /done into complete-interview for v3 questions', async () => {
  const terminal = new FakeTerminal();
  terminal.answers.push('/done');
  const resumes: unknown[] = [];
  const results: PipelineRuntimeResult[] = [
    {
      status: 'paused', runId: 'run-1',
      pause: { id: 'q1', nodeId: 'plan', type: 'question', content: 'Anything else?', format: 'markdown' },
      snapshot: snapshot('paused'),
    },
    {
      status: 'completed', runId: 'run-1',
      artifact: { name: 'plan', type: 'text', format: 'markdown', value: 'ready', producerNodeId: 'plan' },
      snapshot: snapshot('completed'),
    },
  ];
  const host = {
    start: async () => results.shift()!,
    resume: async (_runId: string, decision: unknown) => {
      resumes.push(decision);
      return results.shift()!;
    },
  };

  const result = await runPipelineInteractive(host, terminal, command());

  assert.equal(result.status, 'completed');
  assert.deepEqual(resumes, [{ pauseId: 'q1', kind: 'complete-interview' }]);
  assert.deepEqual(terminal.questions, ['Answer [/done to finish]:']);
  assert.equal(terminal.output[0], '\n## Pipeline question\n\nAnything else?\n');
});

test('--yes auto-approves approvals but never promotions', async () => {
  const terminal = new FakeTerminal();
  terminal.confirmations.push(false);
  const decisions: unknown[] = [];
  const results: PipelineRuntimeResult[] = [
    {
      status: 'paused', runId: 'run-1',
      pause: { id: 'a1', nodeId: 'approval', type: 'approval', content: 'Plan', format: 'proposed-plan' },
      snapshot: snapshot('paused'),
    },
    {
      status: 'paused', runId: 'run-1',
      pause: { id: 'p1', nodeId: 'promotion', type: 'promotion', content: 'Apply changes', format: 'markdown' },
      snapshot: snapshot('paused'),
    },
    { status: 'cancelled', runId: 'run-1', snapshot: snapshot('cancelled') },
  ];
  const host = {
    start: async () => results.shift()!,
    resume: async (_runId: string, decision: unknown) => {
      decisions.push(decision);
      return results.shift()!;
    },
  };

  const result = await runPipelineInteractive(host, terminal, command({ yes: true }));

  assert.equal(result.status, 'cancelled');
  assert.deepEqual(decisions, [
    { pauseId: 'a1', kind: 'approve', value: 'Plan' },
    { pauseId: 'p1', kind: 'reject' },
  ]);
});

test('json mode prints the normalized final result without pause prompts', async () => {
  const terminal = new FakeTerminal();
  const host = {
    start: async (): Promise<PipelineRuntimeResult> => ({
      status: 'completed',
      runId: 'run-json',
      artifact: {
        name: 'result',
        type: 'json',
        format: 'json',
        value: { ok: true, tickets: 3 },
        producerNodeId: 'finish',
      },
      snapshot: { ...snapshot('completed'), runId: 'run-json' },
    }),
    resume: async (): Promise<PipelineRuntimeResult> => {
      throw new Error('resume should not be called');
    },
  };

  const result = await runPipelineInteractive(host, terminal, command({ json: true }));

  assert.equal(result.status, 'completed');
  assert.deepEqual(terminal.questions, []);
  assert.deepEqual(terminal.errors, []);
  assert.deepEqual(JSON.parse(terminal.output[0] ?? ''), {
    status: 'completed',
    runId: 'run-json',
    artifact: {
      name: 'result',
      type: 'json',
      format: 'json',
      value: { ok: true, tickets: 3 },
      producerNodeId: 'finish',
    },
  });
});

test('plain mode pretty prints object artifacts', async () => {
  const terminal = new FakeTerminal();
  const host = {
    start: async (): Promise<PipelineRuntimeResult> => ({
      status: 'completed',
      runId: 'run-object',
      artifact: {
        name: 'result',
        type: 'json',
        format: 'json',
        value: { issue: 'pipeline-cli', covered: true },
        producerNodeId: 'finish',
      },
      snapshot: { ...snapshot('completed'), runId: 'run-object' },
    }),
    resume: async (): Promise<PipelineRuntimeResult> => {
      throw new Error('resume should not be called');
    },
  };

  const result = await runPipelineInteractive(host, terminal, command());

  assert.equal(result.status, 'completed');
  assert.equal(terminal.output[0], JSON.stringify({ issue: 'pipeline-cli', covered: true }, null, 2));
});

test('reports failed and cancelled final results on stderr', async () => {
  const failedTerminal = new FakeTerminal();
  const failedHost = {
    start: async (): Promise<PipelineRuntimeResult> => ({
      status: 'failed',
      runId: 'run-failed',
      error: { code: 'agent_failed', message: 'Agent timed out' },
      snapshot: { ...snapshot('failed'), runId: 'run-failed' },
    }),
    resume: async (): Promise<PipelineRuntimeResult> => {
      throw new Error('resume should not be called');
    },
  };

  const failed = await runPipelineInteractive(failedHost, failedTerminal, command());

  assert.equal(failed.status, 'failed');
  assert.deepEqual(failedTerminal.errors, ['Pipeline failed [agent_failed]: Agent timed out']);

  const cancelledTerminal = new FakeTerminal();
  const cancelledHost = {
    start: async (): Promise<PipelineRuntimeResult> => ({
      status: 'cancelled',
      runId: 'run-cancelled',
      snapshot: { ...snapshot('cancelled'), runId: 'run-cancelled' },
    }),
    resume: async (): Promise<PipelineRuntimeResult> => {
      throw new Error('resume should not be called');
    },
  };

  const cancelled = await runPipelineInteractive(cancelledHost, cancelledTerminal, command());

  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelledTerminal.errors, ['Pipeline cancelled.']);
});

test('reports a rejected Pipeline Change Set distinctly from cancellation', async () => {
  const terminal = new FakeTerminal();
  const rejected = Object.assign({
    status: 'cancelled' as const,
    runId: 'run-rejected',
    snapshot: { ...snapshot('cancelled'), runId: 'run-rejected' },
  }, { promotion: 'rejected' as const }) as PipelineRuntimeResult;
  const host = {
    start: async (): Promise<PipelineRuntimeResult> => rejected,
    resume: async (): Promise<PipelineRuntimeResult> => {
      throw new Error('resume should not be called');
    },
  };

  const result = await runPipelineInteractive(host, terminal, command());

  assert.equal(result.status, 'rejected');
  assert.deepEqual(terminal.errors, ['Pipeline Change Set rejected.']);
});

test('reports failed final results with node and attempt context when available', async () => {
  const terminal = new FakeTerminal();
  const host = {
    start: async (): Promise<PipelineRuntimeResult> => ({
      status: 'failed',
      runId: 'run-failed',
      error: { code: 'agent_failed', message: 'Internal error', nodeId: 'implementer', attempt: 2 },
      snapshot: { ...snapshot('failed'), runId: 'run-failed' },
    }),
    resume: async (): Promise<PipelineRuntimeResult> => {
      throw new Error('resume should not be called');
    },
  };

  const failed = await runPipelineInteractive(host, terminal, command());

  assert.equal(failed.status, 'failed');
  assert.deepEqual(terminal.errors, ['Pipeline failed [agent_failed] at node "implementer" attempt 2: Internal error']);
});

test('keeps asking until a question receives a non-empty answer', async () => {
  const terminal = new FakeTerminal();
  terminal.answers.push('', 'Use retries');
  const decisions: unknown[] = [];
  const results: PipelineRuntimeResult[] = [
    {
      status: 'paused', runId: 'run-1',
      pause: { id: 'q1', nodeId: 'question', type: 'question', content: 'How?', format: 'markdown' },
      snapshot: snapshot('paused'),
    },
    {
      status: 'completed', runId: 'run-1',
      artifact: { name: 'result', type: 'text', format: 'markdown', value: 'done', producerNodeId: 'finish' },
      snapshot: snapshot('completed'),
    },
  ];
  const host = {
    start: async () => results.shift()!,
    resume: async (_runId: string, decision: unknown) => {
      decisions.push(decision);
      return results.shift()!;
    },
  };

  const result = await runPipelineInteractive(host, terminal, command());

  assert.equal(result.status, 'completed');
  assert.deepEqual(terminal.questions, [
    'Answer [/done to finish]:',
    'Answer [/done to finish]:',
  ]);
  assert.deepEqual(terminal.errors, ['An answer is required to resume this pipeline question.']);
  assert.deepEqual(decisions, [{ pauseId: 'q1', kind: 'answer', value: 'Use retries' }]);
});

// formatPipelineList tests
test('formatPipelineList with non-empty list in text mode produces stable format', () => {
  const entries: CliPipelineListEntry[] = [
    { id: 'pipeline-1', title: 'Pipeline One', nodeCount: 3 },
    { id: 'pipeline-2', title: 'Pipeline Two', nodeCount: 5 },
  ];
  const result = formatPipelineList(entries, false);
  assert.equal(result, '- pipeline-1 — Pipeline One (3 nodes)\n- pipeline-2 — Pipeline Two (5 nodes)');
});

test('formatPipelineList with non-empty list in JSON mode produces valid JSON', () => {
  const entries: CliPipelineListEntry[] = [
    { id: 'pipeline-1', title: 'Pipeline One', nodeCount: 3 },
    { id: 'pipeline-2', title: 'Pipeline Two', nodeCount: 5 },
  ];
  const result = formatPipelineList(entries, true);
  const parsed = JSON.parse(result);
  assert.deepEqual(parsed, entries);
});

test('formatPipelineList with empty list in text mode shows clear message', () => {
  const result = formatPipelineList([], false);
  assert.equal(result, 'No valid ACP version 3 pipelines found in .acp/pipelines.');
});

test('formatPipelineList with empty list in JSON mode returns empty array', () => {
  const result = formatPipelineList([], true);
  assert.equal(result, '[]');
});

test('formatPipelineList with single pipeline in text mode', () => {
  const entries: CliPipelineListEntry[] = [
    { id: 'single', title: 'Single Pipeline', nodeCount: 1 },
  ];
  const result = formatPipelineList(entries, false);
  assert.equal(result, '- single — Single Pipeline (1 nodes)');
});
