import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compilePipelineV3Definition, PipelineRuntimeAgentAdapter, type PipelineAgentRunInput } from '../dist/index.js';

async function executeOutput(text: string, format: 'json' | 'markdown') {
  const program = compilePipelineV3Definition({
    version: 3, id: 'adapter', title: 'Adapter', nodes: [{
      id: 'tasks', agent: 'Vibe', prompt: 'Create tickets',
      output: { name: 'tickets', type: 'acp.ticket-graph/v1', format },
    }],
  }, { Vibe: {} }).program!;
  const adapter = new PipelineRuntimeAgentAdapter({ workspaceCwd: () => '/tmp', runAgent: async () => text });
  return adapter.execute({
    runId: 'adapter', attempt: 1, node: program.nodes[0], prompt: 'Create tickets', inputs: {},
    signal: new AbortController().signal,
  });
}

test('agent adapter decodes bare and fenced JSON before publishing typed artifacts', async () => {
  const graph = { contract: 'acp.ticket-graph/v1', tickets: [{ id: 'T01', title: 'Fix', scope: ['behavior'], needs: [], validation: ['test'] }] };
  for (const text of [JSON.stringify(graph), `\`\`\`json\n${JSON.stringify(graph)}\n\`\`\``, `Here is the graph:\n\`\`\`json\n${JSON.stringify(graph)}\n\`\`\`\nDone.`]) {
    const result = await executeOutput(text, 'json');
    assert.ok('artifact' in result);
    assert.deepEqual(result.artifact.value, graph);
  }
});

test('agent adapter rejects malformed JSON and preserves Markdown text', async () => {
  const ambiguous = await executeOutput('```json\n{}\n```\n```json\n{}\n```', 'json');
  assert.ok('code' in ambiguous);
  const invalid = await executeOutput('not json', 'json');
  assert.ok('code' in invalid);
  const markdown = await executeOutput('## Documentation\n`path`', 'markdown');
  assert.ok('artifact' in markdown);
  assert.equal(markdown.artifact.value, '## Documentation\n`path`');
});


test('repairs missing JSON once in a distinct read-only call while retaining the original checkpoint', async () => {
  const program = compilePipelineV3Definition({ version: 3, id: 'repair', title: 'Repair', nodes: [{ id: 'tasks', agent: 'Vibe', prompt: 'Create tickets', policy: { filesystem: 'workspace-write' }, output: { name: 'tickets', type: 'acp.ticket-graph/v1', format: 'json' } }] }, { Vibe: {} }).program!;
  const calls: PipelineAgentRunInput[] = [];
  const state = { sandboxName: 'original', runId: 'repair', nodeId: 'tasks', attempt: 1, baseCommit: 'base', integrationState: 'checkpointed' as const, resourceState: 'removed' as const, checkpoint: { status: 'checkpointed' as const, commit: 'original-commit', remote: 'remote', ref: 'refs/original', preview: { baseCommit: 'base', checkpointCommit: 'original-commit', fileCount: 1, files: ['spec.md'], diff: '' } } };
  const graph = { contract: 'acp.ticket-graph/v1', tickets: [{ id: 'T01', title: 'Fix', scope: ['fix'], needs: [], validation: ['test'] }] };
  const retained: unknown[] = [];
  const adapter = new PipelineRuntimeAgentAdapter({ workspaceCwd: () => '/tmp', runAgent: async request => {
    calls.push(request);
    if (calls.length === 1) { await request.onSandboxRunState?.(state); return 'Now I will return the JSON.'; }
    assert.equal(request.nodeId, 'tasks-output-repair');
    assert.equal(request.sideEffects, 'none');
    assert.equal(request.promotion, 'discard');
    assert.equal(request.resumeSandboxRun, undefined);
    assert.equal(request.onSandboxRunState, undefined);
    assert.equal(request.dependencyCheckpoints?.[0].checkpoint.commit, 'original-commit');
    return JSON.stringify(graph);
  } });
  const result = await adapter.execute({ runId: 'repair', attempt: 1, node: program.nodes[0], prompt: 'Create tickets', inputs: {}, signal: new AbortController().signal, onSandboxRunState: state => { retained.push(state); } });
  assert.ok('artifact' in result);
  assert.deepEqual(result.artifact.value, graph);
  assert.equal(calls.length, 2);
  assert.deepEqual(retained, [state]);
});
