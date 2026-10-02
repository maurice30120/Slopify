import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compilePipelineV3Definition, PipelineRuntimeAgentAdapter } from '../dist/index.js';

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
