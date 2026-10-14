import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { SubprocessExecutor } from '@acp-client/sandbox';
import { TaskBatchService, type BatchTask, type TaskBatchSnapshot } from '../src/taskBatch.js';
import { activityJournalPath, readActivitySignals } from '../src/activityJournal.js';
import { parseActivitySignal, type ActivitySignal } from '../src/activitySignal.js';
import type { ActivityTickClock } from '../src/activityTick.js';

/** Tick minute du Signal d'activité dans le service d'exécution (ADR 0013) :
 * comportement externe uniquement — le seam onActivitySignal, le journal du run
 * dans le store, l'invariabilité des preuves — piloté par un faux exécuteur qui
 * écrit le log de la tentative au fil de l'eau et une horloge injectée. */

function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const task = (id: string, agent: 'pi' | 'codex', dependsOn: string[] = []): BatchTask => ({
  id, agent, dependsOn, prompt: id, source: `${id}.md`,
});

/** Horloge manuelle : le temps n'avance que quand le test le décide, tick rapide et déterministe. */
class ManualActivityClock implements ActivityTickClock {
  private waiters: Array<() => void> = [];
  private instant = new Date('2026-01-01T00:00:00Z');
  /** Nombre de ticks réellement levés pendant la commande : prouve que le tick a tourné. */
  firedTicks = 0;
  now(): Date { return new Date(this.instant); }
  wait(_intervalMs: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      if (signal.aborted) return resolve();
      const settle = () => {
        const index = this.waiters.indexOf(settle);
        if (index >= 0) this.waiters.splice(index, 1);
        signal.removeEventListener('abort', settle);
        resolve();
      };
      signal.addEventListener('abort', settle, { once: true });
      this.waiters.push(settle);
    });
  }
  /** Avance le temps d'une minute et lève chaque tick en attente ; l'émission rend la main au test. */
  async advanceMinute(): Promise<void> {
    this.instant = new Date(this.instant.getTime() + 60_000);
    const waiting = this.waiters.splice(0);
    this.firedTicks += waiting.length;
    for (const settle of waiting) settle();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

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
  hooks: { onSbx?: (args: string[]) => Promise<void>; onActivitySignal?: (signal: ActivitySignal) => void } = {},
): Promise<TickFixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-activity-tick-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'host');
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(repo, 'base.txt'), 'committed base');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const head = git(repo, 'rev-parse', 'HEAD');
  const skills = path.join(root, 'official-skills');
  await mkdir(path.join(skills, 'code-review'), { recursive: true });
  await writeFile(path.join(skills, 'code-review', 'SKILL.md'), 'Official review reference');
  await writeFile(path.join(root, 'spec.md'), '# Approved specification');
  const batchFile = path.join(root, 'batch.json');
  await writeFile(batchFile, JSON.stringify({ specFile: 'spec.md', tasks }));
  const sandboxes = new Map<string, string>();
  const launched: string[] = [];
  const removed: string[] = [];
  const execute: SubprocessExecutor = async request => {
    if (request.command === 'git') {
      const r = spawnSync('git', request.args, { cwd: request.cwd, encoding: 'utf8' });
      return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    assert.equal(request.command, 'sbx');
    const a = request.args;
    await hooks.onSbx?.(a);
    const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
    if (a[0] === 'version') return ok('sbx 0.47.0');
    if (a.includes('--help')) return ok('--clone --skills --json policy init');
    if (a[0] === 'policy') return ok('{"initialized":true}');
    if (a[0] === 'skills') return ok(JSON.stringify({ store: skills, skills: ['implement', 'tdd', 'code-review'] }));
    if (a[0] === 'kit') return ok('{}');
    if (a[0] === 'ls') return ok('[]');
    if (a[0] === 'create') {
      const name = a[a.indexOf('--name') + 1];
      const sandbox = path.join(root, name);
      execFileSync('git', ['clone', '-q', request.cwd!, sandbox]);
      git(request.cwd!, 'remote', 'add', `sandbox-${name}`, sandbox);
      sandboxes.set(name, sandbox);
      return ok();
    }
    if (a[0] === 'rm') { removed.push(a.at(-1)!); return ok(); }
    if (a[0] === 'cp') {
      if (a.at(-1)?.endsWith('codex-sessions')) {
        await mkdir(a.at(-1)!);
        await writeFile(path.join(a.at(-1)!, 'native.jsonl'), '{"type":"response_item"}\n');
      }
      return ok();
    }
    if (a[0] === 'exec') {
      const name = a.find((v: string) => sandboxes.has(v));
      const sandbox = name ? sandboxes.get(name)! : undefined;
      assert.ok(sandbox, 'execution uses its own created sandbox');
      const index = a.indexOf('git');
      if (index >= 0) {
        const r = spawnSync('git', a.slice(index + 1), { cwd: sandbox, encoding: 'utf8' });
        return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      }
      if (a.some((v: string) => v.includes('npm root -g'))) return ok('/opt/pi/examples/extensions/subagent/index.ts\n');
      if (a.includes('sh') && a.some((v: string) => v.includes('$HOME/.codex/sessions'))) return ok('/home/agent/.codex/sessions');
      if ((a.includes('codex') && a.includes('--json')) || (a.includes('pi') && a.includes('--print'))) {
        const id = String(a.at(-1)).includes('code-review au diff complet') ? 'final-review' : a.at(-1)!;
        launched.push(id);
        const emit = (text: string) => request.onOutput?.('stdout', `${text}\n`);
        const exitCode = await agent(id, sandbox, emit, request.cwd!);
        const stdout = a.includes('pi')
          ? JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `${id} report\nSLOPIFY_RESULT={"status":"succeeded"}` }] } })
          : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `${id} report\nSLOPIFY_RESULT={"status":"succeeded"}` } });
        request.onOutput?.('stdout', stdout + '\n');
        return { exitCode, stdout: stdout + '\n', stderr: exitCode ? `${id} failed` : '' };
      }
      return ok();
    }
    throw new Error(`Unhandled sbx ${a.join(' ')}`);
  };
  const signals: ActivitySignal[] = [];
  const clock = new ManualActivityClock();
  const updates: TaskBatchSnapshot[] = [];
  const storePath = path.join(root, 'runs');
  const service = new TaskBatchService({
    repositoryPath: repo, storePath, subprocessExecutor: execute,
    onUpdate: snapshot => { updates.push(snapshot); },
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
  let journal = await readActivitySignals(activityJournalPath(f.storePath, runId), 0);
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
  journal = await readActivitySignals(activityJournalPath(f.storePath, runId), 0);
  assert.equal(journal.length, before, 'le journal ne gagne rien après la fin');
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
  const f = await fixture(t, [task('work', 'pi')], async (id, sandbox, emit) => {
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
  const journal = await readActivitySignals(activityJournalPath(f.storePath, interrupted.runId), 0);
  assert.deepEqual(journal, f.signals, 'le journal du run persiste les signaux de la tentative isolée');
  retriedHold.release();
  const retried = await retrying;
  assert.equal(retried.tasks[0].status, 'succeeded');
  assert.equal(retried.tasks[0].attempts.length, 2, 'la reprise isolée crée une tentative distincte');
});

test('tasks resolve-conflict émet des signaux pendant la reprise des vagues', { timeout: 30000 }, async t => {
  const cStarted = gate(); const cHold = gate();
  t.after(() => { cHold.release(); });
  const f = await fixture(t, [
    task('task-a', 'pi'), task('task-b', 'codex'), task('task-c', 'pi', ['task-a']),
  ], async (id, sandbox, emit) => {
    if (id === 'task-a' || id === 'task-b') {
      await writeFile(path.join(sandbox, 'base.txt'), `${id} modified content`);
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
  });
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
  const journal = await readActivitySignals(activityJournalPath(f.storePath, conflicted.runId), 0);
  assert.deepEqual(journal, f.signals, 'les signaux de la résolution sont journalisés dans le run');
});

test('tasks validate-resolution émet des signaux pendant la reprise des vagues', { timeout: 30000 }, async t => {
  const cStarted = gate(); const cHold = gate();
  t.after(() => { cHold.release(); });
  const f = await fixture(t, [
    task('task-a', 'pi'), task('task-b', 'codex'), task('task-c', 'pi', ['task-a']),
  ], async (id, sandbox, emit) => {
    if (id === 'task-a' || id === 'task-b') {
      await writeFile(path.join(sandbox, 'base.txt'), `${id} modified content`);
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
  });
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
  const journal = await readActivitySignals(activityJournalPath(f.storePath, conflicted.runId), 0);
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
  assert.deepEqual(await readActivitySignals(activityJournalPath(f.storePath, snapshot.runId), 0), []);
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
  const journal = await readActivitySignals(activityJournalPath(f.storePath, state.runId), 0);
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
