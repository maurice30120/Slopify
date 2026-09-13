import assert from 'node:assert/strict';
import test from 'node:test';
import { PipelineProgressDecoder, stripProgress, PipelineRuntimeAgentAdapter, PipelineRuntime, InMemoryPipelineRunStore, compilePipelineV3Definition, type AgentNodeSessionActivity } from '../dist/index.js';

const payload = { action: 'Ajoute un contrôle', target: 'TokenValidator.ts', result: '', next: 'Tests ciblés' };
const marker = `<slopify_progress>${JSON.stringify(payload)}</slopify_progress>`;

test('decodes split public progress, ignores thoughts and invalid data, combines observed tools', () => {
  const events: AgentNodeSessionActivity[] = [];
  const decoder = new PipelineProgressDecoder(activity => events.push(activity));
  decoder.accept({ sessionId: 's', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: marker } } });
  for (const char of marker) decoder.accept({ sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: char } } });
  decoder.accept({ sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: marker } } });
  decoder.accept({ sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '<slopify_progress>{"action":"bad","extra":"value"}</slopify_progress>' } } });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].progress, { ...payload, source: 'agent' });
  decoder.accept({ sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'private command argument', kind: 'execute', status: 'completed', rawInput: { secret: 'do not copy' } } });
  assert.equal(events[1].progress?.action, payload.action);
  assert.equal(events[1].progress?.observation, 'Exécution : Outil terminé');
  assert.doesNotMatch(JSON.stringify(events), /private command|do not copy/);
  assert.equal(stripProgress(`${marker}\n{"answer":42}`), '{"answer":42}');
});

test('oversized or malformed updates recover at the next valid marker', () => {
  const events: AgentNodeSessionActivity[] = [];
  const decoder = new PipelineProgressDecoder(activity => events.push(activity));
  const accept = (text: string) => decoder.accept({ sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
  accept('<slopify_progress>' + 'x'.repeat(3000));
  accept('<slopify_progress>not-json</slopify_progress>');
  accept(marker);
  assert.equal(events.length, 1);
});

test('adapter persists independent node progress before completion and keeps JSON artifacts clean', async () => {
  const compiled = compilePipelineV3Definition({ version: 3, id: 'progress', nodes: ['left', 'right'].map(id => ({ id, agent: 'fake', prompt: id, output: { name: 'result', type: 'test/result', format: 'json' } })) }, { fake: {} });
  assert.ok(compiled.program, compiled.errors.join('\n'));
  const store = new InMemoryPipelineRunStore();
  const runtime = new PipelineRuntime(new PipelineRuntimeAgentAdapter({ workspaceCwd: () => '/tmp', runAgent: async input => {
    assert.match(input.prompt?.instructions ?? '', /slopify_progress/);
    input.onSessionUpdate?.({ sessionId: input.nodeId!, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: marker } } });
    await new Promise(resolve => setTimeout(resolve, input.nodeId === 'left' ? 10 : 1));
    return `${marker}\n{"answer":42}`;
  } }), { store, runIdFactory: () => 'progress-run' });
  const result = await runtime.start(compiled.program);
  assert.equal(result.status, 'completed');
  const durable = await store.load(result.runId);
  assert.equal(durable?.status, 'completed');
  assert.deepEqual(Object.keys(durable?.progress ?? {}).sort(), ['left', 'right']);
  assert.deepEqual(durable?.artifacts['left.result'].value, { answer: 42 });
  assert.equal((await store.readEvents(result.runId)).filter(event => event.type === 'agent_activity').length, 2);
});
