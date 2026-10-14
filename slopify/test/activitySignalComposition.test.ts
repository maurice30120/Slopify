import assert from 'node:assert/strict';
import test from 'node:test';
import { composeActivitySignal } from '../src/activitySignalComposition.js';

const now = new Date('2026-10-14T10:04:00Z');

test('a task with news produces one task entry carrying its sentence and source', () => {
  const signal = composeActivitySignal({
    runId: 'run-1',
    now,
    tasks: [{ taskId: 'sa-1', news: { sentence: 'les tests passent', source: 'log' } }],
  });
  assert.deepEqual(signal, {
    version: 1,
    runId: 'run-1',
    timestamp: '2026-10-14T10:04:00.000Z',
    tasks: [{ taskId: 'sa-1', sentence: 'les tests passent', source: 'log' }],
  });
});
