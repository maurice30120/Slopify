import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  publishPipelineArtifacts,
  type PipelineArtifact,
  type PipelineRuntimeSnapshot,
} from '../dist/index.js';

test('publishPipelineArtifacts writes spec.md and one file per markdown ticket', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-artifacts-'));
  const specification = [
    '# Spécification — Pipeline ACP avec décisions par défaut',
    '',
    '## Problem Statement',
    '',
    'The generated artifacts must exist in the workspace.',
  ].join('\n');
  const tickets = [
    '# Ordered Tracer-Bullet Task Plan',
    '',
    '## T01 — Publier les artifacts',
    '',
    '**Blocked by:** None — can start immediately',
    '',
    '- [ ] Write spec.md',
    '',
    '## T02 — Brancher les hôtes',
    '',
    '**Blocked by:** T01',
    '',
    '- [ ] Use the shared publisher',
    '',
    '## Frontier',
    '',
    '- T01',
  ].join('\n');

  try {
    const publication = publishPipelineArtifacts(
      workspace,
      createSnapshot({
        'spec.specification': artifact(
          'spec',
          'specification',
          'acp.specification/v1',
          specification,
        ),
        'tasks.tickets': artifact(
          'tasks',
          'tickets',
          'acp.ticket-graph/v1',
          tickets,
        ),
      }),
    );

    assert.ok(publication);
    assert.equal(
      publication.directory,
      '.scratch/pipeline-acp-avec-decisions-par-defaut',
    );
    assert.equal(publication.ticketCount, 2);
    assert.deepEqual(publication.files, [
      '.scratch/pipeline-acp-avec-decisions-par-defaut/spec.md',
      '.scratch/pipeline-acp-avec-decisions-par-defaut/issues/README.md',
      '.scratch/pipeline-acp-avec-decisions-par-defaut/issues/01-publier-les-artifacts.md',
      '.scratch/pipeline-acp-avec-decisions-par-defaut/issues/02-brancher-les-hotes.md',
    ]);

    const outputDirectory = path.join(workspace, publication.directory);
    assert.equal(
      fs.readFileSync(path.join(outputDirectory, 'spec.md'), 'utf8'),
      `${specification}\n`,
    );
    assert.equal(
      fs.readFileSync(
        path.join(outputDirectory, 'issues', 'README.md'),
        'utf8',
      ),
      `${tickets}\n`,
    );
    const firstTicket = fs.readFileSync(
      path.join(outputDirectory, 'issues', '01-publier-les-artifacts.md'),
      'utf8',
    );
    assert.match(firstTicket, /^# 01 — Publier les artifacts/m);
    assert.match(firstTicket, /\*\*Ticket ID:\*\* T01/);
    assert.match(firstTicket, /Write spec\.md/);

    const secondTicket = fs.readFileSync(
      path.join(outputDirectory, 'issues', '02-brancher-les-hotes.md'),
      'utf8',
    );
    assert.match(secondTicket, /\*\*Blocked by:\*\* T01/);
    assert.doesNotMatch(secondTicket, /Frontier/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('publishPipelineArtifacts replaces stale generated ticket files', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-artifacts-'));

  try {
    const issuesDirectory = path.join(
      workspace,
      '.scratch',
      'stable-feature',
      'issues',
    );
    fs.mkdirSync(issuesDirectory, { recursive: true });
    fs.writeFileSync(path.join(issuesDirectory, '01-old-ticket.md'), 'old\n');
    fs.writeFileSync(path.join(issuesDirectory, 'notes.md'), 'keep\n');

    const publication = publishPipelineArtifacts(
      workspace,
      createSnapshot({
        'tasks.tickets': artifact(
          'tasks',
          'tickets',
          'acp.ticket-graph/v1',
          {
            contract: 'acp.ticket-graph/v1',
            tickets: [
              {
                id: 'T01',
                title: 'New ticket',
                scope: ['Publish the current artifact'],
                needs: [],
                validation: ['npm test'],
              },
            ],
          },
        ),
      }, 'stable-feature'),
    );

    assert.ok(publication);
    assert.equal(publication.ticketCount, 1);
    assert.equal(
      fs.existsSync(path.join(issuesDirectory, '01-old-ticket.md')),
      false,
    );
    assert.equal(
      fs.readFileSync(path.join(issuesDirectory, 'notes.md'), 'utf8'),
      'keep\n',
    );
    assert.equal(
      fs.existsSync(path.join(issuesDirectory, '01-new-ticket.md')),
      true,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

function artifact(
  producerNodeId: string,
  name: string,
  type: string,
  value: unknown,
): PipelineArtifact {
  return {
    producerNodeId,
    name,
    type,
    format: 'markdown',
    value,
  };
}

function createSnapshot(
  artifacts: Record<string, PipelineArtifact>,
  userPrompt = 'Pipeline ACP avec décisions par défaut',
): PipelineRuntimeSnapshot {
  return {
    runId: 'run-artifact-publisher',
    pipelineId: 'grill-spec-tickets-implement-review',
    status: 'paused',
    inputVariables: { userPrompt },
    nodeStates: {},
    artifacts,
    diagnostics: [],
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:01.000Z',
  };
}
