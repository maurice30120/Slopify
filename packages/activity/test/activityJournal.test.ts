import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ACTIVITY_JOURNAL_FILE, activityJournalPath, appendActivitySignal, readActivitySignals, readAllActivitySignals } from '../src/activityJournal.js';
import type { ActivitySignal } from '../src/activitySignal.js';

function signal(runId: string, minute: number, taskId = 'sa-1'): ActivitySignal {
  return {
    version: 1,
    runId,
    timestamp: `2026-10-13T10:${String(minute).padStart(2, '0')}:00.000Z`,
    tasks: [{ taskId, sentence: `minute ${minute}: building the activity signal contract`, source: 'log' }],
  };
}

async function store(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-activity-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('the journal lives beside state.json in the run directory of the store', () => {
  assert.equal(activityJournalPath('/store', 'run-1'), path.join('/store', 'run-1', ACTIVITY_JOURNAL_FILE));
  assert.equal(ACTIVITY_JOURNAL_FILE, 'activity.jsonl');
});

test('appending writes one JSON line per signal without corrupting previous entries', async (t) => {
  const root = await store(t);
  const journal = activityJournalPath(root, 'run-1');
  await appendActivitySignal(journal, signal('run-1', 1));
  await appendActivitySignal(journal, signal('run-1', 2));
  await appendActivitySignal(journal, signal('run-1', 3));
  const contents = await readFile(journal, 'utf8');
  const lines = contents.split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[3], '');
  assert.deepEqual(lines.slice(0, 3).map(line => JSON.parse(line).tasks[0].sentence), [
    'minute 1: building the activity signal contract',
    'minute 2: building the activity signal contract',
    'minute 3: building the activity signal contract',
  ]);
});

test('concurrent appends stay one entry per line and keep every signal', async (t) => {
  const root = await store(t);
  const journal = activityJournalPath(root, 'run-1');
  await Promise.all(Array.from({ length: 5 }, (_, index) => appendActivitySignal(journal, signal('run-1', index + 1))));
  const lines = (await readFile(journal, 'utf8')).split('\n').filter(line => line.length > 0);
  assert.equal(lines.length, 5);
  const minutes = lines.map(line => JSON.parse(line).tasks[0].sentence).sort();
  assert.deepEqual(minutes, [
    'minute 1: building the activity signal contract',
    'minute 2: building the activity signal contract',
    'minute 3: building the activity signal contract',
    'minute 4: building the activity signal contract',
    'minute 5: building the activity signal contract',
  ]);
});

test('appending creates the missing run directory', async (t) => {
  const root = await store(t);
  const journal = activityJournalPath(path.join(root, 'nested'), 'run-1');
  await appendActivitySignal(journal, signal('run-1', 1));
  assert.equal((await readFile(journal, 'utf8')).trim().length > 0, true);
});

test('the reader returns the N last entries in emission order', async (t) => {
  const root = await store(t);
  const journal = activityJournalPath(root, 'run-1');
  for (let minute = 1; minute <= 15; minute += 1) {
    await appendActivitySignal(journal, signal('run-1', minute));
  }
  const window10 = await readActivitySignals(journal);
  assert.equal(window10.length, 10);
  assert.deepEqual(window10.map(parsed => parsed.timestamp),
    Array.from({ length: 10 }, (_, index) => `2026-10-13T10:${String(index + 6).padStart(2, '0')}:00.000Z`));
  const window3 = await readActivitySignals(journal, 3);
  assert.deepEqual(window3.map(parsed => parsed.tasks[0].sentence).at(-1), 'minute 15: building the activity signal contract');
  assert.equal(window3.length, 3);
  const all = await readAllActivitySignals(journal);
  assert.equal(all.length, 15);
  assert.deepEqual(await readActivitySignals(journal, 0), [], 'une fenêtre nulle ou négative est vide, pas le journal entier');
  assert.deepEqual(await readActivitySignals(journal, -2), []);
});

test('the reader returns an empty window when the journal is absent or unreadable', async (t) => {
  const root = await store(t);
  assert.deepEqual(await readActivitySignals(activityJournalPath(root, 'never-created')), []);
  await mkdir(path.join(root, 'run-1'));
  assert.deepEqual(await readActivitySignals(path.join(root, 'run-1')), []);
});

test('the reader skips malformed lines without losing the valid entries around them', async (t) => {
  const root = await store(t);
  const journal = activityJournalPath(root, 'run-1');
  await appendActivitySignal(journal, signal('run-1', 1));
  await appendActivitySignal(journal, signal('run-1', 2));
  const torn = await readFile(journal, 'utf8');
  await writeFile(journal, `${torn}{"version":1,"runId":"run-1"  // torn mid-wr\n${JSON.stringify({ version: 1, runId: 'run-1', timestamp: '2026-10-13T10:03:00.000Z', tasks: [{ taskId: 'sa-1', sentence: 'minute 3', source: 'log' }] })}\nnot json at all\n`);
  await appendActivitySignal(journal, signal('run-1', 4));
  const signals = await readAllActivitySignals(journal);
  assert.deepEqual(signals.map(parsed => parsed.tasks[0].sentence), [
    'minute 1: building the activity signal contract',
    'minute 2: building the activity signal contract',
    'minute 3',
    'minute 4: building the activity signal contract',
  ]);
});
