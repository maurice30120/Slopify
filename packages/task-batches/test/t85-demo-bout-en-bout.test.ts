import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { type BatchTask, type TaskBatchServiceOptions, type TaskBatchSnapshot } from '@slopify/task-batches';
import { TaskBatchService } from './taskBatchTestService.js';
import { runTaskBatchCli } from '@slopify/task-batches';
import { activityJournalPath, readAllActivitySignals } from '@slopify/activity';
import { ACTIVITY_SIGNAL_EVENT_TYPE, parseActivitySignal, type ActivitySignal } from '@slopify/activity';
import { fakeSbxExecutor, gate, git, ManualActivityClock, prepareSlopifyFixture, task } from './activityTickHarness.js';

/** T85 : démonstration observable de bout en bout des Signaux d'activité (ADR 0013).
 * La preuve finale du lot : chaque commande longue est pilotée depuis la CLI avec un
 * faux exécuteur et une horloge injectée ; on observe ce que stderr reçoit réellement
 * (événements activity-signal dédiés en --json, phrases préfixées en texte), que le
 * résultat stdout et les événements progress restent inchangés au byte près pendant
 * que les signaux circulent, et que le journal du run est rattrapable par
 * `tasks status` (dix derniers signaux). Aucune mécanique nouvelle : l'existant intégré. */

interface CliSink {
  messages: string[];
  errors: string[];
}

/** Faux exécuteur + horloge injectée pilotés depuis la CLI : la démonstration observe
 * le vrai canal stderr de `runTaskBatchCli`, sortie injectée, service réel. */
interface DemoFixture {
  root: string;
  repo: string;
  batchFile: string;
  storePath: string;
  clock: ManualActivityClock;
  /** Lance la CLI sur ce fixture ; le service réel reçoit le faux exécuteur et l'horloge injectée. */
  cli(args: string[]): { sink: CliSink; promise: Promise<number> };
}

async function demoFixture(
  t: { after(fn: () => Promise<void>): void },
  tasks: BatchTask[],
  agent: (id: string, sandbox: string, emit: (text: string) => void, cwd: string) => Promise<number>,
  hooks: { onUpdate?: (snapshot: TaskBatchSnapshot) => void } = {},
): Promise<DemoFixture> {
  const { root, repo, skills, batchFile } = await prepareSlopifyFixture('slopify-t85-demo-', t, tasks);
  const sandboxes = new Map<string, string>();
  const execute = fakeSbxExecutor({ root, skills, agent, sandboxes });
  const clock = new ManualActivityClock();
  const storePath = path.join(root, 'runs');
  const cli = (args: string[]) => {
    const sink: CliSink = { messages: [], errors: [] };
    const promise = runTaskBatchCli([...args], {
      write: message => { sink.messages.push(message); },
      writeError: message => { sink.errors.push(message); },
    }, root, (options: TaskBatchServiceOptions) => new TaskBatchService({
      ...options, subprocessExecutor: execute, activityTickIntervalMs: 60_000, activityTickClock: clock,
      onUpdate: snapshot => { options.onUpdate?.(snapshot); hooks.onUpdate?.(snapshot); },
    }));
    return { sink, promise };
  };
  return { root, repo, batchFile, storePath, clock, cli };
}

/** Ligne stderr du canal des Signaux d'activité : événement dédié en --json, phrase préfixée en texte. */
function isActivitySignalLine(line: string, json: boolean): boolean {
  if (json) {
    try { return (JSON.parse(line) as { type?: string }).type === ACTIVITY_SIGNAL_EVENT_TYPE; }
    catch { return false; }
  }
  return line.startsWith('[run ');
}
const activitySignalLines = (sink: CliSink, json: boolean) => sink.errors.filter(line => isActivitySignalLine(line, json));
const progressLines = (sink: CliSink, json: boolean) => sink.errors.filter(line => !isActivitySignalLine(line, json));

/** Fait tourner le tick jusqu'à ce que stderr reçoive `count` signaux ; capé pour échouer vite. */
async function tickUntilSignals(sink: CliSink, clock: ManualActivityClock, count: number, json: boolean, maxMinutes = 100): Promise<void> {
  for (let minute = 0; minute < maxMinutes && activitySignalLines(sink, json).length < count; minute++) {
    await clock.advanceMinute();
    for (let attempt = 0; attempt < 40 && activitySignalLines(sink, json).length < count; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
}

/**
 * Masque les seuls identifiants propres à chaque run — uuid du run et des tentatives,
 * instants muraux de sauvegarde, commits git, noms de sandbox, durée murale mesurée —
 * pour que deux exécutions du même lot restent comparables au byte près sur tout le
 * reste : l'identité des identifiants n'est pas l'objet de la démonstration,
 * l'invariabilité du contenu l'est.
 */
function anonymize(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<instant>')
    .replace(/\b[0-9a-f]{40,64}\b/g, '<commit>')
    .replace(/slopify-[0-9a-f]{24}\b/g, 'slopify-<sandbox>')
    .replace(/Wall clock: \d+ ms/g, 'Wall clock: <wall clock> ms')
    .replace(/"wallClockMs":\d+/g, '"wallClockMs":<ms>')
    .replace(/Active execution: \d+ ms/g, 'Active execution: <active execution> ms')
    .replace(/"activeExecutionMs":\d+/g, '"activeExecutionMs":<ms>');
}

test('tasks run en mode texte : phrases préfixées sur stderr de bout en bout et stdout/progress inchangés au byte près', { timeout: 120000 }, async t => {
  let holdForSignals = false;
  const started = gate(); const firstHold = gate(); const secondHold = gate();
  t.after(() => { firstHold.release(); secondHold.release(); });
  const f = await demoFixture(t, [task('demo', 'pi')], async (id, sandbox, emit) => {
    if (id === 'final-review') { await writeFile(path.join(sandbox, 'review.txt'), 'review'); return 0; }
    if (holdForSignals) {
      started.release();
      emit('Je lis la spécification figée');
      await firstHold.promise;
      emit('Je lance la suite de tests');
      await secondHold.promise;
    }
    await writeFile(path.join(sandbox, 'result.txt'), 'done');
    return 0;
  });
  const args = ['run', f.batchFile, '--cwd', f.repo, '--store', f.storePath];
  const reference = f.cli(args);
  assert.equal(await reference.promise, 0);
  assert.deepEqual(activitySignalLines(reference.sink, false), [], 'aucun signal sans tick levé');
  holdForSignals = true;
  const demonstrated = f.cli(args);
  const running = demonstrated.promise;
  await started.promise;
  await tickUntilSignals(demonstrated.sink, f.clock, 1, false);
  firstHold.release();
  await tickUntilSignals(demonstrated.sink, f.clock, 2, false);
  secondHold.release();
  assert.equal(await running, 0);
  const runId = /^Run ([0-9a-f-]{36}): /.exec(reference.sink.messages[0])![1];
  const demonstratedRunId = /^Run ([0-9a-f-]{36}): /.exec(demonstrated.sink.messages[0])![1];
  // En mode texte, chaque phrase du signal devient une ligne préfixée sur stderr.
  assert.deepEqual(activitySignalLines(demonstrated.sink, false), [
    `[run ${demonstratedRunId}] demo : Je lis la spécification figée\n`,
    `[run ${demonstratedRunId}] demo : Je lance la suite de tests\n`,
  ]);
  assert.notEqual(demonstratedRunId, runId, 'la démonstration est un run distinct de la référence');
  // Invariabilité au byte près du résultat stdout et des événements progress texte.
  assert.equal(demonstrated.sink.messages.length, 1, 'stdout garde un unique résultat final');
  assert.equal(anonymize(demonstrated.sink.messages.join('')), anonymize(reference.sink.messages.join('')),
    'le résultat stdout est inchangé au byte près pendant que les signaux circulent');
  assert.deepEqual(progressLines(demonstrated.sink, false).map(anonymize), progressLines(reference.sink, false).map(anonymize),
    'les événements progress sont inchangés au byte près pendant que les signaux circulent');
});

test('tasks run --json : les signaux circulent sur stderr de bout en bout et stdout/progress restent inchangés au byte près', { timeout: 120000 }, async t => {
  // Le même agent déterministe : la référence s'exécute sans tick, la démonstration
  // tient la tâche active pendant que l'horloge injectée fait circuler les signaux.
  let holdForSignals = false;
  const started = gate(); const firstHold = gate(); const secondHold = gate();
  t.after(() => { firstHold.release(); secondHold.release(); });
  const f = await demoFixture(t, [task('demo', 'pi')], async (id, sandbox, emit) => {
    if (id === 'final-review') { await writeFile(path.join(sandbox, 'review.txt'), 'review'); return 0; }
    if (holdForSignals) {
      started.release();
      emit('Je lis la spécification figée');
      await firstHold.promise;
      emit('Je lance la suite de tests');
      await secondHold.promise;
    }
    await writeFile(path.join(sandbox, 'result.txt'), 'done');
    return 0;
  });
  const args = ['run', f.batchFile, '--cwd', f.repo, '--store', f.storePath, '--json'];
  // Référence : le même lot, le même faux exécuteur, aucun signal ne circule.
  const reference = f.cli(args);
  assert.equal(await reference.promise, 0);
  assert.equal(reference.sink.messages.length, 1, 'stdout garde un unique résultat final');
  assert.deepEqual(activitySignalLines(reference.sink, true), [], 'aucun signal sans tick levé');
  // Démonstration : les signaux circulent pendant que la tâche est active.
  holdForSignals = true;
  const demonstrated = f.cli(args);
  const running = demonstrated.promise;
  await started.promise;
  await tickUntilSignals(demonstrated.sink, f.clock, 1, true);
  firstHold.release();
  await tickUntilSignals(demonstrated.sink, f.clock, 2, true);
  secondHold.release();
  assert.equal(await running, 0);
  const runId = JSON.parse(reference.sink.messages[0]).runId;
  // stderr reçoit les signaux comme événements JSON dédiés, distincts des progress.
  const signalEvents = activitySignalLines(demonstrated.sink, true)
    .map(line => JSON.parse(line) as { type: string; runId: string; signal: ActivitySignal });
  assert.equal(signalEvents.length, 2, 'un signal par minute levée, sur le vrai canal stderr de la CLI');
  for (const event of signalEvents) {
    assert.equal(event.type, ACTIVITY_SIGNAL_EVENT_TYPE);
    assert.equal(event.runId !== runId, true, 'la démonstration est un run distinct de la référence');
    assert.ok(parseActivitySignal(event.signal), 'chaque signal respecte le contrat figé v1');
  }
  assert.deepEqual(signalEvents[0].signal.tasks, [{ taskId: 'demo', sentence: 'Je lis la spécification figée', source: 'log' }]);
  assert.equal(signalEvents[0].signal.timestamp, '2026-01-01T00:01:00.000Z', "l'horodatage vient de l'horloge injectée");
  assert.deepEqual(signalEvents[1].signal.tasks, [{ taskId: 'demo', sentence: 'Je lance la suite de tests', source: 'log' }]);
  assert.equal(signalEvents[1].signal.timestamp, '2026-01-01T00:02:00.000Z');
  // Le journal du run persiste les signaux intégraux, rattrapables après coup.
  const journal = await readAllActivitySignals(activityJournalPath(f.storePath, JSON.parse(demonstrated.sink.messages[0]).runId));
  assert.deepEqual(journal, signalEvents.map(event => event.signal), 'le journal du run porte les signaux complets');
  // Invariabilité au byte près : stdout et événements progress identiques à la référence,
  // au seul masquage des identifiants propres à chaque run près.
  assert.equal(demonstrated.sink.messages.length, 1, 'stdout garde un unique résultat final');
  assert.equal(anonymize(demonstrated.sink.messages.join('')), anonymize(reference.sink.messages.join('')),
    'le résultat stdout est inchangé au byte près pendant que les signaux circulent');
  const demoProgress = progressLines(demonstrated.sink, true).map(anonymize);
  const referenceProgress = progressLines(reference.sink, true).map(anonymize);
  assert.deepEqual(demoProgress, referenceProgress,
    'les événements progress sont inchangés au byte près pendant que les signaux circulent');
  assert.equal(demoProgress.length, referenceProgress.length);
  assert.ok(demoProgress.length > 0, 'la démonstration a bien observé des événements progress');
  // Aucune trace du mécanisme d'observation ne fuit dans stdout ou les progress.
  for (const line of [...demonstrated.sink.messages, ...progressLines(demonstrated.sink, true)]) {
    assert.ok(!line.includes('activity-signal'), 'aucun événement de signal hors du canal dédié');
    assert.ok(!line.includes('Je lis la spécification figée'), 'aucune phrase du tick dans stdout ou progress');
  }
});

test('tasks resume : la reprise émet ses signaux sur stderr de bout en bout et les journalise dans le run', { timeout: 120000 }, async t => {
  const firstStarted = gate(); const hold = gate(); const resumeStarted = gate(); const resumeHold = gate();
  t.after(() => { hold.release(); resumeHold.release(); });
  let attempt = 0;
  const f = await demoFixture(t, [task('demo', 'pi')], async (id, sandbox, emit) => {
    if (id === 'final-review') { await writeFile(path.join(sandbox, 'review.txt'), 'review'); return 0; }
    attempt += 1;
    if (attempt === 1) {
      firstStarted.release();
      emit('Première tentative interrompue');
      await hold.promise;
      return 1;
    }
    resumeStarted.release();
    emit('Reprise après interruption');
    await resumeHold.promise;
    await writeFile(path.join(sandbox, 'result.txt'), 'recovered');
    return 0;
  });
  const location = ['--cwd', f.repo, '--store', f.storePath];
  // Interruption de la première exécution, elle aussi observée depuis la CLI.
  const first = f.cli(['run', f.batchFile, ...location, '--json']);
  await firstStarted.promise;
  process.emit('SIGINT');
  hold.release();
  assert.equal(await first.promise, 2);
  const interrupted = JSON.parse(first.sink.messages[0]);
  assert.equal(interrupted.status, 'interrupted');
  assert.deepEqual(activitySignalLines(first.sink, true), [], 'aucun signal sans tick levé pendant le run interrompu');
  // tasks resume : la même mécanique de tick émet pendant la reprise.
  const resumed = f.cli(['resume', interrupted.runId, ...location, '--json']);
  const resuming = resumed.promise;
  await resumeStarted.promise;
  await tickUntilSignals(resumed.sink, f.clock, 1, true);
  resumeHold.release();
  assert.equal(await resuming, 0);
  const events = activitySignalLines(resumed.sink, true).map(line => JSON.parse(line) as { type: string; runId: string; signal: ActivitySignal });
  assert.equal(events.length, 1, 'un signal par minute levée pendant la reprise');
  assert.equal(events[0].type, ACTIVITY_SIGNAL_EVENT_TYPE);
  assert.equal(events[0].runId, interrupted.runId);
  assert.deepEqual(events[0].signal.tasks, [{ taskId: 'demo', sentence: 'Reprise après interruption', source: 'log' }]);
  assert.equal(events[0].signal.timestamp, '2026-01-01T00:01:00.000Z', "l'horodatage vient de l'horloge injectée");
  const journal = await readAllActivitySignals(activityJournalPath(f.storePath, interrupted.runId));
  assert.deepEqual(journal, events.map(event => event.signal), 'les signaux de la reprise sont journalisés dans le run');
  const final = JSON.parse(resumed.sink.messages[0]);
  assert.equal(final.status, 'succeeded');
  assert.equal(final.tasks[0].status, 'succeeded');
});

test('tasks resume-task : la tentative isolée émet ses signaux sur stderr de bout en bout et les journalise', { timeout: 120000 }, async t => {
  const firstStarted = gate(); const hold = gate(); const retriedStarted = gate(); const retriedHold = gate();
  t.after(() => { hold.release(); retriedHold.release(); });
  let attempt = 0;
  const f = await demoFixture(t, [task('work', 'pi')], async (id, sandbox, emit) => {
    if (id === 'final-review') { await writeFile(path.join(sandbox, 'review.txt'), 'review'); return 0; }
    attempt += 1;
    if (attempt === 1) {
      firstStarted.release();
      emit('Tentative initiale interrompue');
      await hold.promise;
      return 1;
    }
    retriedStarted.release();
    emit('Nouvelle tentative isolée');
    await retriedHold.promise;
    await writeFile(path.join(sandbox, 'work.txt'), 'retried');
    return 0;
  });
  const location = ['--cwd', f.repo, '--store', f.storePath];
  const first = f.cli(['run', f.batchFile, ...location, '--json']);
  await firstStarted.promise;
  process.emit('SIGINT');
  hold.release();
  assert.equal(await first.promise, 2);
  const interrupted = JSON.parse(first.sink.messages[0]);
  assert.equal(interrupted.status, 'interrupted');
  // tasks resume-task : la nouvelle tentative est observée par le tick.
  const retried = f.cli(['resume-task', interrupted.runId, 'work', ...location, '--json']);
  const retrying = retried.promise;
  await retriedStarted.promise;
  await tickUntilSignals(retried.sink, f.clock, 1, true);
  retriedHold.release();
  // La reprise isolée n'exécute que la tâche demandée : les vagues restantes (dont la
  // revue finale) ne sont pas rejouées, le run durable se termine donc « failed ».
  assert.equal(await retrying, 2);
  const events = activitySignalLines(retried.sink, true).map(line => JSON.parse(line) as { type: string; runId: string; signal: ActivitySignal });
  assert.equal(events.length, 1, 'un signal par minute levée pendant la tentative isolée');
  assert.equal(events[0].type, ACTIVITY_SIGNAL_EVENT_TYPE);
  assert.equal(events[0].runId, interrupted.runId);
  assert.deepEqual(events[0].signal.tasks, [{ taskId: 'work', sentence: 'Nouvelle tentative isolée', source: 'log' }]);
  const journal = await readAllActivitySignals(activityJournalPath(f.storePath, interrupted.runId));
  assert.deepEqual(journal, events.map(event => event.signal), 'les signaux de la tentative isolée sont journalisés dans le run');
  const final = JSON.parse(retried.sink.messages[0]);
  assert.equal(final.status, 'failed');
  assert.equal(final.tasks[0].status, 'succeeded');
  assert.equal(final.tasks[0].attempts.length, 2, 'la reprise isolée crée une tentative distincte');
});

test('tasks resolve-conflict : la résolution émet ses signaux sur stderr de bout en bout et les journalise', { timeout: 120000 }, async t => {
  const cStarted = gate(); const cHold = gate(); const conflictDetected = gate();
  t.after(() => { cHold.release(); conflictDetected.release(); });
  const f = await demoFixture(t, [
    task('task-a', 'pi'), task('task-b', 'codex'), task('drained', 'pi'), task('task-c', 'pi', ['drained']),
  ], async (id, sandbox, emit) => {
    if (id === 'task-a' || id === 'task-b') {
      await writeFile(path.join(sandbox, 'base.txt'), `${id} modified content`);
      return 0;
    }
    if (id === 'drained') {
      await conflictDetected.promise;
      await writeFile(path.join(sandbox, 'drained.txt'), 'retained during conflict');
      return 0;
    }
    if (id === 'task-c') {
      cStarted.release();
      emit('Implémente la vague suivante');
      await cHold.promise;
      await writeFile(path.join(sandbox, 'c.txt'), 'done');
      return 0;
    }
    await writeFile(path.join(sandbox, 'review.txt'), 'review');
    return 0;
  }, { onUpdate: snapshot => { if (snapshot.conflict) conflictDetected.release(); } });
  const location = ['--cwd', f.repo, '--store', f.storePath];
  const conflictedRun = f.cli(['run', f.batchFile, ...location, '--json']);
  assert.equal(await conflictedRun.promise, 2);
  const conflicted = JSON.parse(conflictedRun.sink.messages[0]);
  assert.equal(conflicted.status, 'conflicted');
  assert.deepEqual(activitySignalLines(conflictedRun.sink, true), [], 'aucun signal sans tick levé pendant le run en conflit');
  // tasks resolve-conflict : la reprise des vagues est observée par le tick.
  const resolving = f.cli(['resolve-conflict', conflicted.runId, '--strategy', 'use-current', ...location, '--json']);
  const resolution = resolving.promise;
  await cStarted.promise;
  await tickUntilSignals(resolving.sink, f.clock, 1, true);
  cHold.release();
  assert.equal(await resolution, 2, 'la tâche rejetée par use-current laisse le run failed');
  const events = activitySignalLines(resolving.sink, true).map(line => JSON.parse(line) as { type: string; runId: string; signal: ActivitySignal });
  assert.equal(events.length, 1, 'un signal par minute levée pendant la résolution');
  assert.equal(events[0].type, ACTIVITY_SIGNAL_EVENT_TYPE);
  assert.equal(events[0].runId, conflicted.runId);
  assert.deepEqual(events[0].signal.tasks, [{ taskId: 'task-c', sentence: 'Implémente la vague suivante', source: 'log' }]);
  const journal = await readAllActivitySignals(activityJournalPath(f.storePath, conflicted.runId));
  assert.deepEqual(journal, events.map(event => event.signal), 'les signaux de la résolution sont journalisés dans le run');
  const final = JSON.parse(resolving.sink.messages[0]);
  assert.equal(final.tasks.find((taskState: { id: string }) => taskState.id === 'task-c')!.status, 'succeeded');
});

test('tasks validate-resolution : la validation émet ses signaux sur stderr de bout en bout et les journalise', { timeout: 120000 }, async t => {
  const cStarted = gate(); const cHold = gate(); const conflictDetected = gate();
  t.after(() => { cHold.release(); conflictDetected.release(); });
  const f = await demoFixture(t, [
    task('task-a', 'pi'), task('task-b', 'codex'), task('drained', 'pi'), task('task-c', 'pi', ['drained']),
  ], async (id, sandbox, emit) => {
    if (id === 'task-a' || id === 'task-b') {
      await writeFile(path.join(sandbox, 'base.txt'), `${id} modified content`);
      return 0;
    }
    if (id === 'drained') {
      await conflictDetected.promise;
      await writeFile(path.join(sandbox, 'drained.txt'), 'retained during conflict');
      return 0;
    }
    if (id === 'task-c') {
      cStarted.release();
      emit('Implémente après validation');
      await cHold.promise;
      await writeFile(path.join(sandbox, 'c.txt'), 'done');
      return 0;
    }
    await writeFile(path.join(sandbox, 'review.txt'), 'review');
    return 0;
  }, { onUpdate: snapshot => { if (snapshot.conflict) conflictDetected.release(); } });
  const location = ['--cwd', f.repo, '--store', f.storePath];
  const conflictedRun = f.cli(['run', f.batchFile, ...location, '--json']);
  assert.equal(await conflictedRun.promise, 2);
  const conflicted = JSON.parse(conflictedRun.sink.messages[0]);
  assert.equal(conflicted.status, 'conflicted');
  // Résolution manuelle : la sandbox dédiée est créée, observable depuis la sortie stdout de la CLI.
  const manual = f.cli(['resolve-conflict', conflicted.runId, '--strategy', 'manual', ...location, '--json']);
  assert.equal(await manual.promise, 2, 'la résolution manuelle suspend le run en attendant le travail utilisateur');
  const manualState = JSON.parse(manual.sink.messages[0]);
  assert.ok(manualState.resolution, 'la résolution manuelle crée sa sandbox dédiée');
  const resolution = manualState.resolution!;
  // L'utilisateur résout à la main dans la sandbox dédiée, au-dessus du commit d'intégration.
  await writeFile(path.join(resolution.sandboxPath, 'base.txt'), 'résolu à la main');
  git(resolution.sandboxPath, 'config', 'user.name', 'Test');
  git(resolution.sandboxPath, 'config', 'user.email', 'test@example.invalid');
  git(resolution.sandboxPath, 'add', 'base.txt');
  git(resolution.sandboxPath, 'commit', '-qm', 'manual resolution');
  // tasks validate-resolution : la reprise des vagues est observée par le tick.
  const validating = f.cli(['validate-resolution', conflicted.runId, resolution.resolutionId, ...location, '--json']);
  const validation = validating.promise;
  await cStarted.promise;
  await tickUntilSignals(validating.sink, f.clock, 1, true);
  cHold.release();
  assert.equal(await validation, 0);
  const events = activitySignalLines(validating.sink, true).map(line => JSON.parse(line) as { type: string; runId: string; signal: ActivitySignal });
  assert.equal(events.length, 1, 'un signal par minute levée pendant la validation');
  assert.equal(events[0].type, ACTIVITY_SIGNAL_EVENT_TYPE);
  assert.equal(events[0].runId, conflicted.runId);
  assert.deepEqual(events[0].signal.tasks, [{ taskId: 'task-c', sentence: 'Implémente après validation', source: 'log' }]);
  const journal = await readAllActivitySignals(activityJournalPath(f.storePath, conflicted.runId));
  assert.deepEqual(journal, events.map(event => event.signal), 'les signaux de la validation sont journalisés dans le run');
  const final = JSON.parse(validating.sink.messages[0]);
  assert.equal(final.status, 'succeeded');
});

test('tasks status rattrape les dix derniers signaux du journal du run, émis par le vrai tick de la commande', { timeout: 120000 }, async t => {
  // Douze minutes de narration : le tick du run journalise douze signaux réels,
  // produits par le faux exécuteur et l'horloge injectée, observés sur stderr.
  const MINUTES = 12;
  const WINDOW = 10;
  const started = gate();
  const minuteDone = Array.from({ length: MINUTES }, () => gate());
  t.after(() => { for (const gateToRelease of minuteDone) gateToRelease.release(); });
  const f = await demoFixture(t, [task('demo', 'pi')], async (id, sandbox, emit) => {
    if (id === 'final-review') { await writeFile(path.join(sandbox, 'review.txt'), 'review'); return 0; }
    started.release();
    for (let minute = 1; minute <= MINUTES; minute++) {
      emit(`Minute ${minute} : je rédige le test ${minute}`);
      await minuteDone[minute - 1].promise;
    }
    await writeFile(path.join(sandbox, 'result.txt'), 'done');
    return 0;
  });
  const location = ['--cwd', f.repo, '--store', f.storePath];
  const running = f.cli(['run', f.batchFile, ...location, '--json']);
  const run = running.promise;
  await started.promise;
  for (let minute = 1; minute <= MINUTES; minute++) {
    await tickUntilSignals(running.sink, f.clock, minute, true);
    const signal = JSON.parse(activitySignalLines(running.sink, true)[minute - 1]) as { signal: ActivitySignal };
    assert.deepEqual(signal.signal.tasks, [{ taskId: 'demo', sentence: `Minute ${minute} : je rédige le test ${minute}`, source: 'log' }]);
    minuteDone[minute - 1].release();
  }
  assert.equal(await run, 0);
  const runId = JSON.parse(running.sink.messages[0]).runId;
  const journal = await readAllActivitySignals(activityJournalPath(f.storePath, runId));
  assert.equal(journal.length, MINUTES, 'le journal du run persiste les douze signaux du tick');
  assert.equal(activitySignalLines(running.sink, true).length, MINUTES, 'stderr a observé les douze signaux de bout en bout');
  // Rattrapage en mode texte : la fenêtre affiche les dix derniers signaux du journal.
  const textStatus = f.cli(['status', runId, ...location]);
  assert.equal(await textStatus.promise, 0);
  const lines = textStatus.sink.messages[0].split('\n');
  const start = lines.indexOf('Recent activity signals:');
  assert.ok(start >= 0, 'le rapport de status a une section signaux');
  const window = lines.slice(start + 1, start + 1 + WINDOW);
  assert.equal(window.length, WINDOW, 'seuls dix signaux sont gardés en mode texte');
  assert.deepEqual(window, Array.from({ length: WINDOW }, (_, index) => {
    const minute = index + MINUTES - WINDOW + 1;
    return `  [2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z] demo : Minute ${minute} : je rédige le test ${minute}`;
  }), 'la fenêtre replaye les dix derniers signaux du journal, dans l\'ordre d\'émission');
  assert.ok(!lines.some(line => line.includes('je rédige le test 1 ') || line.includes('je rédige le test 2 ')),
    'les deux signaux les plus anciens ne sont pas rejoués');
  assert.deepEqual(textStatus.sink.errors, [], 'status n\'écrit rien sur stderr');
  // Rattrapage en mode --json : les dix derniers voyagent dans le résultat final.
  const jsonStatus = f.cli(['status', runId, ...location, '--json']);
  assert.equal(await jsonStatus.promise, 0);
  const result = JSON.parse(jsonStatus.sink.messages[0]);
  assert.equal(result.activitySignals.length, WINDOW, 'seuls dix signaux sont gardés en --json');
  assert.deepEqual(result.activitySignals, journal.slice(-WINDOW), 'les dix derniers, dans l\'ordre du journal');
  assert.deepEqual(jsonStatus.sink.errors, []);
});
