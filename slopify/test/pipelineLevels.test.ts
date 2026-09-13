import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { getPipelinePrograms } from '@acp-client/workspace';

test('loads the simple, moyen, and full pipeline levels from the workspace catalog', () => {
  const workspaceRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  const programs = getPipelinePrograms(workspaceRoot);
  const byId = new Map(programs.map(program => [program.id, program]));

  assert.deepEqual(
    ['simple', 'moyen', 'full'].map(id => byId.get(id)?.id),
    ['simple', 'moyen', 'full'],
  );

  const simple = byId.get('simple');
  assert.ok(simple);
  assert.deepEqual(simple.nodes.map(node => node.id), ['implementation']);
  assert.equal(simple.nodes[0]?.agent, 'Codex Sandbox');
  assert.equal(simple.nodes[0]?.policy.filesystem, 'workspace-write');

  const moyen = byId.get('moyen');
  assert.ok(moyen);
  assert.deepEqual(moyen.nodes.map(node => node.id), [
    'plan',
    'plan_approval',
    'implementation',
    'review',
  ]);
  assert.equal(moyen.nodes[1]?.pause, 'approval');
  assert.deepEqual(moyen.nodes[2]?.needs, ['plan_approval']);
  assert.deepEqual(moyen.nodes[3]?.needs, ['implementation']);
  assert.deepEqual(moyen.nodes[3]?.inputs.map(input => input.from), [
    'plan_approval.approvedPlan',
    'implementation.result',
  ]);

  const full = byId.get('full');
  assert.ok(full);
  assert.deepEqual(full.nodes.map(node => node.id), [
    'plan',
    'plan_approval',
    'spec',
    'tasks',
    'delivery_approval',
  ]);
  assert.equal(full.nodes[4]?.handoff?.minimumReferences, 2);
});

test('keeps the existing specialized pipelines available', () => {
  const workspaceRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  const ids = getPipelinePrograms(workspaceRoot).map(program => program.id);

  assert.ok(ids.includes('grill-spec-tickets-implement-review'));
  assert.ok(ids.includes('implement-ticket'));
  assert.ok(ids.includes('review-delivery'));
});
