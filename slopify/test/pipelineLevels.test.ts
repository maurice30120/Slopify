import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { getPipelinePrograms } from '@acp-client/workspace';

test('preserves legacy parallel ticket compilation as a library fixture', () => {
  const fixtureRoot = path.resolve(import.meta.dirname, '../../test/fixtures/legacy-workspace');
  const programs = getPipelinePrograms(fixtureRoot);

  assert.deepEqual(
    programs.map(program => program.id),
    ['full'],
  );

  const full = programs[0];
  assert.ok(full);
  assert.equal(full.promotion, 'ask', 'full delivery must request promotion instead of silently discarding it');
  assert.equal(full.maxConcurrency, 3, 'parallel ticket implementation must be concurrency-bounded');

  assert.deepEqual(full.nodes.map(node => node.id), [
    'plan',
    'plan_approval',
    'spec',
    'tasks',
    'delivery_approval',
  ]);
  assert.equal(full.nodes[4]?.handoff?.minimumReferences, 2);

  const tasks = full.nodes.find(node => node.id === 'tasks');
  const delivery = full.nodes.find(node => node.id === 'delivery_approval');
  assert.ok(tasks);
  assert.ok(delivery);
  assert.equal(tasks.output?.type, 'acp.ticket-graph/v1', 'parallel delivery requires an authoritative Ticket Graph');
  assert.equal(tasks.output?.format, 'json');
  assert.equal(delivery.inputs.find(input => input.from === 'tasks.tickets')?.type, 'acp.ticket-graph/v1');
});
