import assert from 'node:assert/strict';
import test from 'node:test';
import { WAVE_SIZE, selectReadyWave, blockDescendants } from '../src/scheduler/taskSelection.js';
import type { BatchTaskState } from '../src/taskBatch.js';

const task = (id: string, status: BatchTaskState['status'], dependsOn: string[] = []): BatchTaskState =>
  ({ id, status, dependsOn, agent: 'pi', prompt: id, source: `${id}.md`, attempts: [] });

/** T1 : tests de caractérisation du scheduler V2 — la sélection et le blocage sont figés sans changement du moteur. */
test('characterization: only pending tasks with all-succeeded dependencies are selected, in stable JSON order', () => {
  const tasks = [
    task('first', 'pending'),
    task('second', 'pending'),
    task('third', 'pending', ['first']),
    task('done', 'succeeded'),
    task('child-of-done', 'pending', ['done']),
  ];
  const wave = selectReadyWave(tasks);
  assert.deepEqual(wave.map(t => t.id), ['first', 'second', 'child-of-done'],
    'selection is ready-only, descendant-count first, then stable JSON order');
});

test('characterization: equal priority prefers unlocking the most direct descendants', () => {
  const tasks = [
    task('plain', 'pending'),
    task('hub', 'pending'),
    task('h1', 'pending', ['hub']),
    task('h2', 'pending', ['hub']),
  ];
  const wave = selectReadyWave(tasks);
  assert.equal(wave[0].id, 'hub', 'hub unlocks two direct descendants and comes first');
  assert.deepEqual(wave.slice(1).map(t => t.id), ['plain']);
});

test('characterization: the wave is capped at ten tasks', () => {
  const tasks = Array.from({ length: 15 }, (_, index) => task(`t-${index}`, 'pending'));
  const wave = selectReadyWave(tasks);
  assert.equal(wave.length, WAVE_SIZE);
  assert.equal(wave[0].id, 't-0', 'stable JSON order beyond the cap');
});

test('characterization: a failed dependency blocks its descendants in cascade', () => {
  const tasks = [
    task('root', 'failed'),
    task('child', 'pending', ['root']),
    task('grandchild', 'pending', ['child']),
    task('independent', 'pending'),
  ];
  blockDescendants(tasks);
  assert.equal(tasks.find(t => t.id === 'child')!.status, 'blocked');
  assert.deepEqual(tasks.find(t => t.id === 'child')!.blockedBy, ['root']);
  assert.equal(tasks.find(t => t.id === 'grandchild')!.status, 'blocked', 'blocking cascades');
  assert.equal(tasks.find(t => t.id === 'independent')!.status, 'pending', 'independent tasks are untouched');
});

test('characterization: an interrupted dependency also blocks descendants', () => {
  const tasks = [task('crashed', 'interrupted'), task('after', 'pending', ['crashed'])];
  blockDescendants(tasks);
  assert.equal(tasks[1].status, 'blocked');
});
