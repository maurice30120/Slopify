import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { type BatchTask, type TaskBatchSnapshot } from '@slopify/task-batches';
import { TaskBatchService } from './taskBatchTestService.js';
import { activityJournalPath, readAllActivitySignals } from '@slopify/activity';
import { parseActivitySignal, type ActivitySignal } from '@slopify/activity';
import { readAttemptLogTail } from '@slopify/activity';
import { fakeSbxExecutor, gate, git, ManualActivityClock, prepareSlopifyFixture, task } from './activityTickHarness.js';

/** Tick minute du Signal d'activité dans le service d'exécution (ADR 0013) :
 * comportement externe uniquement — le seam onActivitySignal, le journal du run
 * dans le store, l'invariabilité des preuves — piloté par un faux exécuteur qui
 * écrit le log de la tentative au fil de l'eau et une horloge injectée. */

/** Fait tourner le tick jusqu'à ce que `signals` atteigne `count` ; capé pour échouer vite. */
async function tickUntil(signals: ActivitySignal[], clock: ManualActivityClock, count: number, maxMinutes = 100): Promise<void> {
  for (let minute = 0; minute < maxMinutes && signals.length < count; minute++) {
    await clock.advanceMinute();
    for (let attempt = 0; attempt < 20 && signals.length < count; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  }
}

interface TickFixture {
  root: string;
  repo: string;
  head: string;
  batchFile: string;
  storePath: string;
  service: TaskBatchService;
  signals: ActivitySignal[];
  clock: ManualActivityClock;
  updates: TaskBatchSnapshot[];
  launched: string[];
  sandboxes: Map<string, string>;
  removed: string[];
}

/** Substitute sbx alone: all clones, commits, checkpoints and published branches are real Git. */
async function fixture(
  t: { after(fn: () => Promise<void>): void },
  tasks: BatchTask[],
  agent: (id: string, sandbox: string, emit: (text: string) => void, cwd: string) => Promise<number>,
  hooks: { onSbx?: (args: string[]) => Promise<void>; onActivitySignal?: (signal: ActivitySignal) => void; onUpdate?: (snapshot: TaskBatchSnapshot) => void } = {},
): Promise<TickFixture> {
  const { root, repo, head, skills, batchFile } = await prepareSlopifyFixture('slopify-activity-tick-', t, tasks);
  const sandboxes = new Map<string, string>();
  const launched: string[] = [];
  const removed: string[] = [];
  const execute = fakeSbxExecutor({ root, skills, agent, sandboxes, onSbx: hooks.onSbx, launched, removed });
  const signals: ActivitySignal[] = [];
  const clock = new ManualActivityClock();
  const updates: TaskBatchSnapshot[] = [];
  const storePath = path.join(root, 'runs');
  const service = new TaskBatchService({
    repositoryPath: repo, storePath, subprocessExecutor: execute,
    onUpdate: snapshot => { updates.push(snapshot); hooks.onUpdate?.(snapshot); },
    onActivitySignal: signal => {
      signals.push(signal);
      hooks.onActivitySignal?.(signal);
    },
    activityTickIntervalMs: 60_000,
    activityTickClock: clock,
  });
  return { root, repo, head, batchFile, storePath, service, signals, clock, updates, launched, sandboxes, removed };
}

test('chaque tick minute de tasks run produit un signal complet via le seam et une entrée du journal', { timeout: 30000 }, async t => {
  const started = gate(); const firstHold = gate(); const secondHold = gate();
  t.after(() => { firstHold.release(); secondHold.release(); });
  const f = await fixture(t, [task('narrated', 'pi')], async (id, sandbox, emit) => {
    if (id === 'final-review') { await writeFile(path.join(sandbox, 'review.txt'), 'review'); return 0; }
    started.release();
    emit('Je lis la spécification figée');
    await firstHold.promise;
    emit('Je lance la suite de tests');
    await secondHold.promise;
    await writeFile(path.join(sandbox, 'result.txt'), 'done');
    return 0;
  });
  const running = f.service.run(f.batchFile);
  await started.promise;
  await tickUntil(f.signals, f.clock, 1);
  const runId = f.updates[0].runId;
  const first = f.signals[0];
  assert.ok(parseActivitySignal(first), 'le signal respecte le contrat figé v1');
  assert.equal(first.version, 1);
  assert.equal(first.runId, runId);
  assert.equal(first.timestamp, new Date('2026-01-01T00:01:00Z').toISOString(), "l'horodatage vient de l'horloge injectée");
  assert.deepEqual(first.tasks, [{ taskId: 'narrated', sentence: 'Je lis la spécification figée', source: 'log' }]);
  assert.equal(first.grouped, undefined);
  assert.equal(first.integration, undefined);
  let journal = await readAllActivitySignals(activityJournalPath(f.storePath, runId));
  assert.deepEqual(journal, [first], 'le journal du run persiste le signal intégral');
  // Une minute sans nouveau contenu : la tâche active sans nouvelles est regroupée.
  await tickUntil(f.signals, f.clock, 2);
  const second = f.signals[1];
  assert.deepEqual(second.tasks, []);
  assert.deepEqual(second.grouped, { taskIds: ['narrated'], sentence: 'rien de nouveau depuis 1 minute', source: 'none' });
  // Du nouveau dans le log de la tentative : une nouvelle phrase par tâche.
  firstHold.release();
  await tickUntil(f.signals, f.clock, 3);
  assert.deepEqual(f.signals[2].tasks, [{ taskId: 'narrated', sentence: 'Je lance la suite de tests', source: 'log' }]);
  secondHold.release();
  const state = await running;
  assert.equal(state.status, 'succeeded');
  // Après la fin de la commande : l'horloge peut avancer, plus aucun signal.
  const before = f.signals.length;
  for (let minute = 0; minute < 3; minute++) await f.clock.advanceMinute();
  assert.equal(f.signals.length, before, 'aucun signal après la fin');
  journal = await readAllActivitySignals(activityJournalPath(f.storePath, runId));
  assert.equal(journal.length, before, 'le journal ne gagne rien après la fin');
});

test("un événement JSONL coupé à la frontière du tick ne fuit jamais comme phrase significative", { timeout: 30000 }, async t => {
  const started = gate(); const firstHold = gate();
  t.after(() => { firstHold.release(); });
  const f = await fixture(t, [task('jsonl', 'pi')], async (id, sandbox, emit) => {
    if (id === 'final-review') { await writeFile(path.join(sandbox, 'review.txt'), 'review'); return 0; }
    started.release();
    emit('Je lis la spécification figée');
    await firstHold.promise;
    emit('Je corrige les tests');
    await writeFile(path.join(sandbox, 'result.txt'), 'done');
    return 0;
  });
  const running = f.service.run(f.batchFile);
  await started.promise;
  await tickUntil(f.signals, f.clock, 1);
  assert.deepEqual(f.signals[0].tasks, [{ taskId: 'jsonl', sentence: 'Je lis la spécification figée', source: 'log' }]);
  // Un événement JSONL n'est écrit qu'à moitié à la frontière du tick, sans saut de ligne.
  const runId = f.updates[0].runId;
  const attemptsDir = path.join(f.storePath, runId, 'attempts');
  const [attemptId] = await readdir(attemptsDir);
  const logPath = path.join(attemptsDir, attemptId, 'stdout.log');
  await appendFile(logPath, '{"type":"message_end","message":{"status"');
  await tickUntil(f.signals, f.clock, 2);
  assert.deepEqual(f.signals[1].tasks, [], 'un fragment incomplet ne devient jamais une phrase');
  // La ligne est complétée au tick suivant : elle est lue entière et rejetée par le filtre JSON figé.
  await appendFile(logPath, ':"succeeded"}}}\n');
  await tickUntil(f.signals, f.clock, 3);
  assert.deepEqual(f.signals[2].tasks, [], 'la ligne JSONL complétée est filtrée comme bloc JSON, jamais émise en fragments');
  for (const signal of f.signals) {
    for (const taskSignal of signal.tasks ?? []) {
      assert.ok(!taskSignal.sentence.includes('}}'), `un fragment JSON a fui dans : ${taskSignal.sentence}`);
    }
  }
  // La prose suivante redevient la phrase du Signal d'activité.
  firstHold.release();
  await tickUntil(f.signals, f.clock, 4);
  assert.deepEqual(f.signals[3].tasks, [{ taskId: 'jsonl', sentence: 'Je corrige les tests', source: 'log' }]);
  const state = await running;
  assert.equal(state.status, 'succeeded');
  const journal = await readAllActivitySignals(activityJournalPath(f.storePath, runId));
  for (const signal of journal) {
    for (const taskSignal of signal.tasks) {
      assert.ok(!taskSignal.sentence.includes('}}'), `le journal a enregistré un fragment JSON : ${taskSignal.sentence}`);
    }
  }
});

test("le tick s'arrête à l'interruption propagée et aucune reprise ne laisse de signal orphelin", { timeout: 30000 }, async t => {
  const started = gate(); const firstHold = gate(); const resumedHold = gate(); const resumeStarted = gate();
  t.after(() => { firstHold.release(); resumedHold.release(); });
  let workRuns = 0;
  const f = await fixture(t, [task('work', 'pi')], async (id, sandbox, emit) => {
    if (id === 'final-review') { await writeFile(path.join(sandbox, 'review.txt'), 'review'); return 0; }
    workRuns++;
    if (workRuns === 1) {
      started.release();
      emit('Première passe interrompue');
      await firstHold.promise;
      return 1;
    }
    resumeStarted.release();
    emit('Reprise après interruption');
    await resumedHold.promise;
    await writeFile(path.join(sandbox, 'work.txt'), 'recovered');
    return 0;
  });
  const controller = new AbortController();
  const running = f.service.run(f.batchFile, { signal: controller.signal });
  await started.promise;
  await tickUntil(f.signals, f.clock, 1);
  assert.deepEqual(f.signals[0].tasks.map(taskSignal => taskSignal.taskId), ['work']);
  // Interruption propagée : le tick s'arrête net, même si l'horloge continue d'avancer.
  controller.abort();
  const atAbort = f.signals.length;
  for (let minute = 0; minute < 3; minute++) await f.clock.advanceMinute();
  assert.equal(f.signals.length, atAbort, "aucun signal après l'interruption");
  firstHold.release();
  const interrupted = await running;
  assert.equal(interrupted.status, 'interrupted');
  // tasks resume : la même mécanique de tick émet pendant la reprise.
  const resuming = f.service.resume(interrupted.runId);
  await resumeStarted.promise;
  await tickUntil(f.signals, f.clock, 2);
  const resumedSignal = f.signals[1];
  assert.deepEqual(resumedSignal.tasks, [{ taskId: 'work', sentence: 'Reprise après interruption', source: 'log' }]);
  resumedHold.release();
  const resumed = await resuming;
  assert.equal(resumed.status, 'succeeded');
  assert.equal(resumed.tasks[0].status, 'succeeded');
  const afterResume = f.signals.length;
  for (let minute = 0; minute < 3; minute++) await f.clock.advanceMinute();
  assert.equal(f.signals.length, afterResume, 'aucun signal après la fin de la reprise');
});

test('tasks resume-task émet des signaux pendant sa tentative isolée', { timeout: 30000 }, async t => {
  const started = gate(); const hold = gate(); const retriedStarted = gate(); const retriedHold = gate();
  t.after(() => { hold.release(); retriedHold.release(); });
  let workRuns = 0;
  const f = await fixture(t, [task('work', 'pi')], async (_id, sandbox, emit) => {
    workRuns++;
    if (workRuns === 1) {
      started.release();
      emit('Tentative initiale');
      await hold.promise;
      return 1;
    }
    retriedStarted.release();
    emit('Nouvelle tentative isolée');
    await retriedHold.promise;
    await writeFile(path.join(sandbox, 'work.txt'), 'retried');
    return 0;
  });
  const controller = new AbortController();
  const running = f.service.run(f.batchFile, { signal: controller.signal });
  await started.promise;
  controller.abort();
  hold.release();
  const interrupted = await running;
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.tasks[0].status, 'interrupted');
  assert.equal(f.signals.length, 0, "aucun signal pendant le run interrompu avant tout tick");
  // tasks resume-task : la nouvelle tentative est observée par le tick.
  const retrying = f.service.resumeTask(interrupted.runId, 'work');
  await retriedStarted.promise;
  await tickUntil(f.signals, f.clock, 1);
  assert.deepEqual(f.signals[0].tasks, [{ taskId: 'work', sentence: 'Nouvelle tentative isolée', source: 'log' }]);
  const journal = await readAllActivitySignals(activityJournalPath(f.storePath, interrupted.runId));
  assert.deepEqual(journal, f.signals, 'le journal du run persiste les signaux de la tentative isolée');
  retriedHold.release();
  const retried = await retrying;
  assert.equal(retried.tasks[0].status, 'succeeded');
  assert.equal(retried.tasks[0].attempts.length, 2, 'la reprise isolée crée une tentative distincte');
});

test('tasks resolve-conflict émet des signaux pendant la reprise des vagues', { timeout: 30000 }, async t => {
  const cStarted = gate(); const cHold = gate(); const conflictDetected = gate();
  t.after(() => { cHold.release(); conflictDetected.release(); });
  const f = await fixture(t, [
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
  const conflicted = await f.service.run(f.batchFile);
  assert.equal(conflicted.status, 'conflicted');
  assert.equal(f.signals.length, 0, 'aucun tick levé avant la commande de résolution');
  const resolving = f.service.resolveConflict(conflicted.runId, { resolutionStrategy: 'use-current' });
  await cStarted.promise;
  await tickUntil(f.signals, f.clock, 1);
  assert.deepEqual(f.signals[0].tasks, [{ taskId: 'task-c', sentence: 'Implémente la vague suivante', source: 'log' }]);
  cHold.release();
  const resolved = await resolving;
  assert.equal(resolved.status, 'failed');
  assert.equal(resolved.tasks.find(taskState => taskState.id === 'task-c')!.status, 'succeeded');
  const journal = await readAllActivitySignals(activityJournalPath(f.storePath, conflicted.runId));
  assert.deepEqual(journal, f.signals, 'les signaux de la résolution sont journalisés dans le run');
});

test('tasks validate-resolution émet des signaux pendant la reprise des vagues', { timeout: 30000 }, async t => {
  const cStarted = gate(); const cHold = gate(); const conflictDetected = gate();
  t.after(() => { cHold.release(); conflictDetected.release(); });
  const f = await fixture(t, [
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
  const conflicted = await f.service.run(f.batchFile);
  assert.equal(conflicted.status, 'conflicted');
  const manual = await f.service.resolveConflict(conflicted.runId, { resolutionStrategy: 'manual' });
  assert.ok(manual.resolution, 'la résolution manuelle crée sa sandbox dédiée');
  const resolution = manual.resolution!;
  // L'utilisateur résout à la main dans la sandbox dédiée, au-dessus du commit d'intégration.
  await writeFile(path.join(resolution.sandboxPath, 'base.txt'), 'résolu à la main');
  git(resolution.sandboxPath, 'config', 'user.name', 'Test');
  git(resolution.sandboxPath, 'config', 'user.email', 'test@example.invalid');
  git(resolution.sandboxPath, 'add', 'base.txt');
  git(resolution.sandboxPath, 'commit', '-qm', 'manual resolution');
  assert.equal(f.signals.length, 0, 'aucun tick levé avant la validation');
  const validating = f.service.validateResolution(conflicted.runId, resolution.resolutionId);
  await cStarted.promise;
  await tickUntil(f.signals, f.clock, 1);
  assert.deepEqual(f.signals[0].tasks, [{ taskId: 'task-c', sentence: 'Implémente après validation', source: 'log' }]);
  cHold.release();
  const validated = await validating;
  assert.equal(validated.status, 'succeeded');
  const journal = await readAllActivitySignals(activityJournalPath(f.storePath, conflicted.runId));
  assert.deepEqual(journal, f.signals, 'les signaux de la validation sont journalisés dans le run');
});

test('le tick se tait sans tâche active ni intégration', { timeout: 30000 }, async t => {
  const f = await fixture(t, [task('settled', 'pi')], async () => 0);
  const snapshot = await f.service.run(f.batchFile, { execute: false });
  // Un run déjà entièrement intégré : la reprise n'a ni tâche active ni intégration à observer.
  const runDirectory = path.join(f.storePath, snapshot.runId);
  const workspacePath = path.join(runDirectory, 'integration');
  execFileSync('git', ['clone', '-q', f.repo, workspacePath]);
  git(workspacePath, 'config', 'user.name', 'Test');
  git(workspacePath, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(workspacePath, 'integrated.txt'), 'ahead');
  git(workspacePath, 'add', '.');
  git(workspacePath, 'commit', '-qm', 'ahead');
  const ahead = git(workspacePath, 'rev-parse', 'HEAD');
  git(workspacePath, 'branch', snapshot.integrationBranch, ahead);
  // Le hook de transaction de référence du dépôt hôte étire la publication de la
  // branche d'intégration : une fenêtre large où aucun signal ne doit paraître.
  const hooksDirectory = path.join(f.repo, '.git', 'hooks');
  await writeFile(path.join(hooksDirectory, 'reference-transaction'), '#!/bin/sh\nsleep 0.3\n', { mode: 0o755 });
  snapshot.status = 'failed';
  snapshot.integrationCommit = ahead;
  snapshot.tasks[0].status = 'succeeded';
  snapshot.tasks[0].attempts.push({ attemptId: 'settled-1', taskBaseCommit: snapshot.runBaseCommit, status: 'succeeded', integratedCommit: ahead });
  snapshot.tasks[1].status = 'succeeded';
  await writeFile(path.join(runDirectory, 'state.json'), JSON.stringify(snapshot, null, 2));
  const resuming = f.service.resume(snapshot.runId);
  for (let minute = 0; minute < 40; minute++) await f.clock.advanceMinute();
  const state = await resuming;
  assert.equal(state.status, 'succeeded');
  assert.ok(f.clock.firedTicks >= 3, 'le tick a bien tourné pendant la commande');
  assert.equal(f.signals.length, 0, 'aucun signal sans tâche active ni intégration');
  assert.deepEqual(await readAllActivitySignals(activityJournalPath(f.storePath, snapshot.runId)), []);
});

test("aucune panne des sources ni de l'émission n'interrompt l'exécution d'une tâche", { timeout: 30000 }, async t => {
  const started = gate(); const hold = gate(); const secondHold = gate();
  t.after(() => { hold.release(); secondHold.release(); });
  let resilientRuns = 0;
  const f = await fixture(t, [task('resilient', 'pi')], async (id, sandbox, emit, cwd) => {
    if (id === 'final-review') { await writeFile(path.join(sandbox, 'review.txt'), 'review'); return 0; }
    resilientRuns++;
    if (resilientRuns === 1) {
      // Le log de la tentative devient illisible : la lecture échoue à chaque tick.
      const attemptId = path.basename(cwd);
      const runDirectory = path.dirname(path.dirname(cwd));
      await rm(path.join(runDirectory, 'attempts', attemptId, 'stdout.log'));
      started.release();
      await hold.promise;
      emit('Le log redevient lisible');
      await secondHold.promise;
    }
    await writeFile(path.join(sandbox, 'result.txt'), 'done');
    return 0;
  }, {
    onActivitySignal: () => { throw new Error('le canal stderr est cassé'); },
  });
  const running = f.service.run(f.batchFile);
  await started.promise;
  // Le journal du run est un répertoire : chaque append échoue, silencieusement.
  await mkdir(activityJournalPath(f.storePath, f.updates[0].runId));
  await tickUntil(f.signals, f.clock, 1);
  assert.ok(f.signals[0].grouped, 'une source en panne retombe sur la phrase groupée sans nouvelles');
  assert.deepEqual(f.signals[0].grouped!.taskIds, ['resilient']);
  hold.release();
  await tickUntil(f.signals, f.clock, 2);
  assert.deepEqual(f.signals[1].tasks, [{ taskId: 'resilient', sentence: 'Le log redevient lisible', source: 'log' }]);
  secondHold.release();
  const state = await running;
  assert.equal(state.status, 'succeeded', "l'observabilité n'a jamais interrompu la tâche");
  assert.equal(state.tasks[0].status, 'succeeded');
});

test('les traces de preuve gelées et les prompts restent intacts pendant que les signaux circulent', { timeout: 30000 }, async t => {
  const started = gate(); const hold = gate();
  t.after(() => { hold.release(); });
  const f = await fixture(t, [task('evidence', 'pi')], async (id, sandbox, emit) => {
    if (id === 'final-review') { await writeFile(path.join(sandbox, 'review.txt'), 'review'); return 0; }
    started.release();
    emit('Narration de la tentative');
    await hold.promise;
    await writeFile(path.join(sandbox, 'result.txt'), 'done');
    return 0;
  });
  const running = f.service.run(f.batchFile);
  await started.promise;
  await tickUntil(f.signals, f.clock, 1);
  hold.release();
  const state = await running;
  assert.equal(state.status, 'succeeded');
  // Le prompt et la spécification figée traversent le mécanisme sans réécriture.
  assert.equal(state.tasks[0].prompt, 'evidence');
  assert.equal(state.context.specText, '# Approved specification');
  assert.deepEqual(f.launched.sort(), ['evidence', 'final-review']);
  // Le journal du run, et lui seul, porte les signaux.
  const journal = await readAllActivitySignals(activityJournalPath(f.storePath, state.runId));
  assert.deepEqual(journal, f.signals);
  // Les preuves gelées de la tentative ne contiennent jamais le mécanisme d'observation.
  const attempt = state.tasks[0].attempts[0];
  const stdoutLog = await readFile(attempt.stdoutPath!, 'utf8');
  assert.ok(stdoutLog.includes('Narration de la tentative'), "le log garde la narration de l'agent");
  assert.ok(!stdoutLog.includes('activity-signal'), 'aucun événement de signal dans les preuves stdout');
  assert.ok(!stdoutLog.includes('rien de nouveau'), 'aucune phrase du tick dans les preuves stdout');
  const stderrLog = await readFile(attempt.stderrPath!, 'utf8');
  assert.ok(!stderrLog.includes('activity-signal'), 'aucun événement de signal dans les preuves stderr');
  const commands = (await readFile(path.join(path.dirname(attempt.stdoutPath!), 'commands.jsonl'), 'utf8')).trim().split('\n');
  assert.ok(commands.length > 0, 'le journal des commandes de l\'exécuteur est intact');
  for (const line of commands) {
    const entry = JSON.parse(line) as { type: string; command?: string; args?: string[] };
    assert.ok(['start', 'end', 'cleanup'].includes(entry.type), 'seules les entrées de l\'exécuteur existent');
    assert.ok(!line.includes('activity.jsonl'), 'le tick ne laisse aucune trace dans les commandes observées');
  }
});

test('readAttemptLogTail ne consomme que des lignes complètes et laisse le fragment au tick suivant', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-tail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'stdout.log');
  await writeFile(logPath, 'première ligne complète\n{"type":"message_end"');
  const completeLine = 'première ligne complète\n';
  const first = await readAttemptLogTail(logPath, 0);
  assert.deepEqual(first, { text: completeLine, offset: Buffer.byteLength(completeLine) }, 'seule la ligne complète est consommée');
  await appendFile(logPath, ',"message":"ok"}}\nprose suivante\n');
  const remainder = '{"type":"message_end","message":"ok"}}\nprose suivante\n';
  const second = await readAttemptLogTail(logPath, first!.offset);
  assert.deepEqual(second, { text: remainder, offset: Buffer.byteLength(completeLine) + Buffer.byteLength(remainder) }, 'la ligne complétée est lue entière au tick suivant, jamais en fragments');
});

test('readAttemptLogTail ne consomme rien quand aucune ligne n’est complète', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-tail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'stdout.log');
  await writeFile(logPath, '{"incomplet sans saut de ligne');
  const tail = await readAttemptLogTail(logPath, 0);
  assert.deepEqual(tail, { text: '', offset: 0 }, 'aucun octet n’est consommé sans saut de ligne');
});

/** Le moteur accepte un ActivitySink injecté (issue #171) : le tick traverse le
 * seam sans journaliser ni émettre, et la phrase vient du contenu de la tentative. */
test('un ActivitySink injecté reçoit chaque tick sans toucher au journal du run', { timeout: 30000 }, async t => {
  const started = gate(); const hold = gate();
  t.after(() => { hold.release(); });
  const ticks: unknown[] = [];
  const { root, repo, head, skills, batchFile } = await prepareSlopifyFixture('slopify-activity-sink-', t, [task('sunk', 'pi')]);
  const execute = fakeSbxExecutor({ root, skills, sandboxes: new Map(), agent: async (id, sandbox, emit) => {
    if (id === 'final-review') { await writeFile(path.join(sandbox, 'review.txt'), 'review'); return 0; }
    started.release();
    emit('Je lis la spécification figée');
    await hold.promise;
    await writeFile(path.join(sandbox, 'result.txt'), 'done');
    return 0;
  } });
  const clock = new ManualActivityClock();
  const storePath = path.join(root, 'runs');
  const service = new TaskBatchService({
    repositoryPath: repo, storePath, subprocessExecutor: execute,
    activityTickIntervalMs: 60_000,
    activityTickClock: clock,
    activitySink: { beginRun: async () => ({ tick: async payload => { ticks.push(payload); } }) },
  });
  const running = service.run(batchFile);
  await started.promise;
  for (let minute = 0; minute < 2 && ticks.length < 1; minute++) await clock.advanceMinute();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(ticks.length, 1, 'le sink injecté reçoit exactement un tick');
  const tick = ticks[0] as { runId: string; now: Date; attempts: Array<{ taskId: string; attemptId: string; logPath: string; workspacePath: string }> };
  assert.equal(tick.attempts[0].taskId, 'sunk');
  assert.ok(tick.attempts[0].logPath.endsWith('stdout.log'), 'le tick expose le log de la tentative');
  hold.release();
  const state = await running;
  assert.equal(state.status, 'succeeded');
  const journal = await readAllActivitySignals(activityJournalPath(storePath, state.runId));
  assert.deepEqual(journal, [], 'le sink injecté remplace la journalisation par défaut');
});
