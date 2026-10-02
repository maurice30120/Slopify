import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import { DockerSandboxAcpBridgeAgent } from '../src/acpBridge.js';
import type { DockerSandboxRuntime } from '../src/runtime.js';

async function bridgeOutput(stdout: string, agent: 'codex' | 'vibe') {
  const updates: unknown[] = [];
  const connection = { sessionUpdate: async (update: unknown) => { updates.push(update); } } as unknown as AgentSideConnection;
  const runtime = { runCodex: async () => ({ stdout, stderr: '' }) } as unknown as DockerSandboxRuntime;
  const bridge = new DockerSandboxAcpBridgeAgent(connection, runtime, {
    agent, runId: 'bridge-test', nodeId: 'plan', attempt: 1, model: 'test',
  });
  const { sessionId } = await bridge.newSession({ cwd: '/tmp', mcpServers: [] });
  await bridge.prompt({ sessionId, prompt: [{ type: 'text', text: 'Plan the change' }] });
  return { updates, preview: await bridge.extMethod('sandbox/preview', { sessionId }) };
}

test('Vibe bridge publishes only the last assistant message and preserves raw diagnostics', async () => {
  const final = '<proposed_plan><interview_state>question</interview_state><clarification_question>Format?</clarification_question></proposed_plan>';
  const stdout = JSON.stringify([
    { type: 'message', role: 'user', content: [{ type: 'text', text: '<proposed_plan>template</proposed_plan>' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Exploring the repository' }] },
    { type: 'effect', role: 'assistant', content: [{ type: 'text', text: 'tool output' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'text', text: final }] },
  ]);
  const { updates, preview } = await bridgeOutput(stdout, 'vibe');
  assert.equal(updates.length, 1);
  assert.equal((updates[0] as { update: { content: { text: string } } }).update.content.text, final);
  assert.equal((preview as { result: { stdout: string } }).result.stdout, stdout);
});

test('Codex bridge preserves plain text output', async () => {
  const { updates } = await bridgeOutput('Codex final answer', 'codex');
  assert.equal((updates[0] as { update: { content: { text: string } } }).update.content.text, 'Codex final answer');
});

test('Vibe bridge reports malformed output rather than publishing the transcript', async () => {
  for (const stdout of ['not JSON', '[]', JSON.stringify([{ type: 'message', role: 'user', content: [] }])]) {
    const { updates, preview } = await bridgeOutput(stdout, 'vibe');
    assert.equal(updates.length, 0);
    assert.equal((preview as { ok: boolean }).ok, false);
  }
});
