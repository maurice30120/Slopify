import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PipelineRuntime, compilePipelineV3Definition, getPipelineInterviewProtocol } from '../dist/index.js';

const response = readFileSync('test/fixtures/opencode-markdown-question.txt', 'utf8').trim();

test('OpenCode Markdown questions pause without restarting and resume only on user input', async () => {
  const program = compilePipelineV3Definition({
    version: 3, id: 'markdown-interview', title: 'Markdown interview',
    nodes: [{ id: 'plan', agent: 'OpenCode', prompt: 'Improve comments',
      interaction: { protocol: 'proposed-plan', repairAttempts: 2 },
      output: { name: 'plan', type: 'acp.grill-decision/v1', format: 'markdown' } }],
  }, { OpenCode: {} }).program!;
  let calls = 0;
  const adapter = { async createSession({ runId, node }: { runId: string; node: { id: string } }) {
    return { runId, nodeId: node.id, send: () => adapter.execute(), async cancel() {}, async close() {} };
  }, async execute() {
    calls++;
    return { artifact: { name: 'plan', type: 'acp.grill-decision/v1', format: 'markdown' as const,
      value: calls === 1 ? response : '<proposed_plan><interview_state>ready</interview_state>Approved scope</proposed_plan>' } };
  } };
  const runtime = new PipelineRuntime(adapter);
  const paused = await runtime.start(program);
  assert.equal(paused.status, 'paused');
  if (paused.status !== 'paused') throw new Error('Expected question pause');
  assert.equal(calls, 1);
  assert.equal(paused.pause.type, 'question');
  assert.match(paused.pause.content, /Q1/);
  assert.match(paused.pause.content, /Q3/);
  assert.equal(paused.snapshot.activeInterview?.repairAttemptsUsed, 0);
  const result = await runtime.resume(paused.runId, { pauseId: paused.pause.id, kind: 'answer', value: 'Keep exported symbols only.' });
  assert.equal(result.status, 'completed');
  assert.equal(calls, 2);
});

test('empty question output still fails validation', () => {
  const protocol = getPipelineInterviewProtocol('proposed-plan')!;
  assert.throws(() => protocol.parseAgentOutput('<proposed_plan><interview_state>question</interview_state></proposed_plan>'), /non-empty Markdown question round/);
});

test('Markdown questions preserve the whole round and requires an explicit question state', () => {
  const protocol = getPipelineInterviewProtocol('proposed-plan')!;
  const parsed = protocol.parseAgentOutput(response);
  assert.equal(parsed.state, 'question');
  if (parsed.state !== 'question') throw new Error('Expected question');
  assert.deepEqual(parsed.questions, [response.replace('<proposed_plan>', '').replace('</proposed_plan>', '').replace('<interview_state>question</interview_state>', '').trim()]);
  assert.throws(() => protocol.parseAgentOutput(response.replace('<interview_state>question</interview_state>', '')), /interview_state/);
  assert.equal(protocol.parseAgentOutput(response.replace('<interview_state>question</interview_state>', '<interview_state>ready</interview_state>')).state, 'ready');
});
