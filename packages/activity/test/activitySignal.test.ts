import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVITY_SIGNAL_EVENT_TYPE,
  activitySignalEvent,
  formatActivitySignalEvent,
  parseActivitySignal,
  type ActivitySignal,
} from '../src/activitySignal.js';

const baseSignal: ActivitySignal = {
  version: 1,
  runId: 'run-1',
  timestamp: '2026-10-13T10:04:00.000Z',
  tasks: [
    { taskId: 'sa-1', sentence: 'Signal d’activité : contrat du Signal d’activité en cours.', source: 'log' },
    { taskId: 'sa-2', sentence: 'Extraction de la phrase depuis le log de la tentative.', source: 'git' },
  ],
  grouped: { taskIds: ['sa-3', 'sa-4'], sentence: 'sa-3, sa-4 : rien de nouveau depuis 3 minutes.', source: 'none' },
  integration: { sentence: 'Intégration de la vague 1 en cours.' },
};

test('a well-formed activity signal parses into the frozen contract shape', () => {
  const parsed = parseActivitySignal(baseSignal);
  assert.deepEqual(parsed, baseSignal);
});

test('a minimal signal without grouped or integration sentences parses', () => {
  const minimal: ActivitySignal = {
    version: 1,
    runId: 'run-1',
    timestamp: '2026-10-13T10:05:00.000Z',
    tasks: [{ taskId: 'sa-1', sentence: 'rien de nouveau depuis 5 minutes', source: 'none' }],
  };
  assert.deepEqual(parseActivitySignal(minimal), minimal);
});

test('the dedicated stderr JSON event wraps the signal, one object per line, distinct from progress', () => {
  const event = activitySignalEvent(baseSignal);
  assert.equal(event.type, ACTIVITY_SIGNAL_EVENT_TYPE);
  assert.notEqual(event.type, 'progress');
  assert.equal(event.runId, baseSignal.runId);
  assert.deepEqual(event.signal, baseSignal);

  const line = formatActivitySignalEvent(baseSignal);
  assert.ok(!line.includes('\n'), 'one JSON object per line: no raw newline inside the event');
  const parsed = JSON.parse(line);
  assert.equal(parsed.type, 'activity-signal');
  assert.equal(parsed.runId, 'run-1');
  assert.deepEqual(parseActivitySignal(parsed.signal), baseSignal);
});

test('a signal missing required fields or with an unknown source is rejected', () => {
  const wrongs: unknown[] = [
    'not an object',
    null,
    { ...baseSignal, version: 2 },
    { ...baseSignal, runId: '' },
    { ...baseSignal, timestamp: 42 },
    { ...baseSignal, tasks: 'sa-1' },
    { ...baseSignal, tasks: [{ taskId: '', sentence: 'building', source: 'log' }] },
    { ...baseSignal, tasks: [{ taskId: 'sa-1', sentence: 'building', source: 'llm' }] },
    { ...baseSignal, grouped: { taskIds: [], sentence: 'rien de nouveau.', source: 'none' } },
    { ...baseSignal, grouped: { taskIds: ['sa-3'], sentence: 'rien de nouveau.', source: 'log' } },
    { ...baseSignal, integration: { sentence: 12 } },
  ];
  for (const wrong of wrongs) {
    assert.equal(parseActivitySignal(wrong), undefined, `expected rejection for ${JSON.stringify(wrong)}`);
  }
});
