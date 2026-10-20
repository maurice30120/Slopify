/**
 * Adapter ActivitySink du package activity (ADR 0013, issue #171) : possède la
 * fabrication complète du Signal — lecture incrémentale des logs de tentative,
 * signaux Git, phrases, composition, journal du run et émission via le seam
 * onActivitySignal. Le moteur de lots ne voit que le contrat ActivitySink ;
 * la session de tick (offsets, derniers signaux) vit ici, plus dans le moteur.
 */

import * as path from 'node:path';
import type { ActivitySink, ActivitySinkSession, ActivityTick } from '@slopify/execution';
import { activityJournalPath, appendActivitySignal } from './activityJournal.js';
import { composeActivitySignal, type ActivityTaskCandidate } from './activitySignalComposition.js';
import { activityTaskPhrase } from './activityTaskPhrase.js';
import { extractActivityGitSignal, type ActivityGitSnapshot } from './activitySignalGit.js';
import { readAttemptLogTail } from './activityTick.js';
import type { ActivitySignal } from './activitySignal.js';

interface AttemptReading {
  logOffset: number;
  gitSnapshot: ActivityGitSnapshot | null;
}

/** État de la session de tick d'un run : lectures incrémentales et derniers signaux émis. */
interface RunActivitySessionState {
  attempts: Map<string, AttemptReading>;
  lastSignalAtByTask: Map<string, Date>;
  lastSignalAtByAttempt: Map<string, Date>;
}

export interface RunActivitySinkOptions {
  storePath: string;
  /** Seam d'émission (ADR 0013) : reçoit chaque signal complet composé par le tick. */
  onSignal?: (signal: ActivitySignal) => void;
}

/** Crée l'adapter ActivitySink d'un store : une session par run, le moteur garde la boucle de tick. */
export function createRunActivitySink(options: RunActivitySinkOptions): ActivitySink {
  return {
    beginRun: async (): Promise<ActivitySinkSession> => {
      const state: RunActivitySessionState = { attempts: new Map(), lastSignalAtByTask: new Map(), lastSignalAtByAttempt: new Map() };
      return {
        tick: payload => emitRunActivitySignal(options, state, payload),
      };
    },
  };
}

/** Un tick : compose le Signal des tentatives actives, le journalise puis l'émet ; silencieux sans activité. */
async function emitRunActivitySignal(options: RunActivitySinkOptions, state: RunActivitySessionState, payload: ActivityTick): Promise<void> {
  const candidates: ActivityTaskCandidate[] = [];
  const attemptIdByTask = new Map<string, string>();
  for (const attempt of payload.attempts) {
    attemptIdByTask.set(attempt.taskId, attempt.attemptId);
    // Lecture incrémentale délibérée : le seam de phrase ne voit que le contenu
    // nouveau depuis le tick précédent, pas le log entier. Écart assumé à la
    // lecture littérale de l'US 6 (« dernière ligne significative du log »),
    // cohérent avec l'US 3 (au plus une phrase par tâche et par minute) : une
    // ligne déjà narrée n'est pas réémise chaque minute comme du nouveau.
    const reading = state.attempts.get(attempt.attemptId) ?? { logOffset: 0, gitSnapshot: null };
    const tail = await readAttemptLogTail(attempt.logPath, reading.logOffset);
    if (tail !== undefined) reading.logOffset = tail.offset;
    const git = await extractActivityGitSignal(attempt.workspacePath, reading.gitSnapshot);
    if (git.snapshot !== null) reading.gitSnapshot = git.snapshot;
    state.attempts.set(attempt.attemptId, reading);
    const phrase = activityTaskPhrase({ taskId: attempt.taskId, log: tail?.text, git, now: payload.now, lastSignalAt: state.lastSignalAtByAttempt.get(attempt.attemptId) });
    candidates.push(phrase.source === 'none'
      ? { taskId: attempt.taskId, noNews: true, lastSignalAt: state.lastSignalAtByAttempt.get(attempt.attemptId) }
      : { taskId: attempt.taskId, news: { sentence: phrase.sentence, source: phrase.source } });
  }
  const composed = composeActivitySignal({
    runId: payload.runId, now: payload.now, tasks: candidates,
    lastSignalAtByTask: Object.fromEntries(state.lastSignalAtByTask),
    ...(payload.integrationTaskId !== undefined
      ? { integration: { sentence: `intégration du checkpoint de la tâche ${payload.integrationTaskId}` } }
      : {}),
  });
  // Rien à dire : une tâche active sans nouvelles est groupée, donc un signal
  // sans tâche, sans groupe ni intégration n'apporte rien — il ne pollue pas le journal.
  if (composed.tasks.length === 0 && composed.grouped === undefined && composed.integration === undefined) return;
  for (const taskSignal of composed.tasks) {
    state.lastSignalAtByTask.set(taskSignal.taskId, payload.now);
    const attemptId = attemptIdByTask.get(taskSignal.taskId);
    if (attemptId !== undefined) state.lastSignalAtByAttempt.set(attemptId, payload.now);
  }
  try { await appendActivitySignal(activityJournalPath(options.storePath, payload.runId), composed); }
  catch { /* Le journal ne doit jamais interrompre l'exécution. */ }
  try { options.onSignal?.(composed); }
  catch { /* L'émission ne doit jamais interrompre l'exécution. */ }
}
