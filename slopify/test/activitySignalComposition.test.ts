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

test('bounding: a task already signaled within the same minute is not emitted again', () => {
  const signal = composeActivitySignal({
    runId: 'run-1',
    now,
    tasks: [
      { taskId: 'sa-1', news: { sentence: 'delta git visible', source: 'git' } },
      { taskId: 'sa-2', news: { sentence: 'reprise après une minute', source: 'log' } },
    ],
    lastSignalAtByTask: {
      'sa-1': new Date('2026-10-14T10:04:59Z'), // même minute que now : borné
      'sa-2': new Date('2026-10-14T10:03:59Z'), // minute précédente : émis
    },
  });
  assert.deepEqual(signal.tasks, [{ taskId: 'sa-2', sentence: 'reprise après une minute', source: 'log' }]);
});

test('several tasks without news share one grouped entry listing them all', () => {
  const signal = composeActivitySignal({
    runId: 'run-1',
    now,
    tasks: [
      { taskId: 'sa-2', noNews: true },
      { taskId: 'sa-3', noNews: true },
      { taskId: 'sa-4', noNews: true }, // jamais signalée : silence inconnu, planché à 1 minute
    ],
    lastSignalAtByTask: {
      'sa-2': new Date('2026-10-14T10:02:10Z'), // 1 minute de silence
      'sa-3': new Date('2026-10-14T09:58:00Z'), // 6 minutes de silence : le plus long l'emporte
    },
  });
  assert.deepEqual(signal.tasks, [], 'une tâche sans nouvelles ne produit jamais d’entrée tâche');
  assert.deepEqual(signal.grouped, {
    taskIds: ['sa-2', 'sa-3', 'sa-4'],
    sentence: 'rien de nouveau depuis 6 minutes',
    source: 'none',
  });
});
