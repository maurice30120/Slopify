import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  PipelineService,
  compilePipelineV3Definition,
  type AgentNodeSessionFactory,
  type AgentNodeSessionTurnInput,
} from '../dist/index.js';

test('PipelineService materializes planning artifacts before delivery approval', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-service-artifacts-'));
  const program = compilePipelineV3Definition({
    version: 3,
    id: 'artifact-publishing',
    title: 'Artifact Publishing',
    nodes: [
      {
        id: 'spec',
        agent: 'Codex',
        prompt: 'Write specification',
        output: {
          name: 'specification',
          type: 'acp.specification/v1',
          format: 'markdown',
        },
      },
      {
        id: 'tasks',
        agent: 'Codex',
        prompt: 'Write tickets for {{inputs.specification}}',
        needs: ['spec'],
        inputs: [
          {
            name: 'specification',
            from: 'spec.specification',
            type: 'acp.specification/v1',
            format: 'markdown',
          },
        ],
        output: {
          name: 'tickets',
          type: 'acp.ticket-graph/v1',
          format: 'markdown',
        },
      },
      {
        id: 'delivery_approval',
        type: 'pause',
        pause: 'approval',
        content: 'Approve {{inputs.specification}} and {{inputs.tickets}}',
        needs: ['tasks'],
        inputs: [
          {
            name: 'specification',
            from: 'spec.specification',
            type: 'acp.specification/v1',
            format: 'markdown',
          },
          {
            name: 'tickets',
            from: 'tasks.tickets',
            type: 'acp.ticket-graph/v1',
            format: 'markdown',
          },
        ],
        output: {
          name: 'approved',
          type: 'acp.ticket-graph/v1',
          format: 'markdown',
        },
      },
    ],
  }, { Codex: {} }).program!;

  const service = new PipelineService(
    () => workspace,
    {
      getPipelinePrograms: () => [program],
      getPipelineProgramForAgent: name => name === program.title ? program : null,
      createSession: createFakeSessionFactory(async input => (
        input.prompt === 'Write specification'
          ? '# Spécification — Publication partagée\n\nThe spec body.'
          : [
              '# Ordered Tracer-Bullet Task Plan',
              '',
              '## T01 — Publier depuis PipelineService',
              '',
              '**Blocked by:** None — can start immediately',
              '',
              '- [ ] spec.md exists',
            ].join('\n')
      )),
    },
  );

  try {
    const result = await service.startPipeline(
      'session-publisher',
      'Publication partagée',
      program.title,
    );

    assert.equal(result.status, 'paused');
    const directory = path.join(
      workspace,
      '.scratch',
      'publication-partagee',
    );
    assert.equal(fs.existsSync(path.join(directory, 'spec.md')), true);
    assert.equal(
      fs.existsSync(
        path.join(
          directory,
          'issues',
          '01-publier-depuis-pipelineservice.md',
        ),
      ),
      true,
    );
  } finally {
    await service.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

function createFakeSessionFactory(
  handler: (input: AgentNodeSessionTurnInput) => string | Promise<string>,
): AgentNodeSessionFactory {
  return async ({ runId, node }) => ({
    runId,
    nodeId: node.id,
    async send(input) {
      return {
        artifact: {
          name: input.node.output!.name,
          type: input.node.output!.type,
          format: input.node.output!.format,
          value: await handler(input),
        },
      };
    },
    async cancel() {},
    async close() {},
  });
}
