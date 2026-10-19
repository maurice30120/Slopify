import type { BatchTaskAttempt, BatchTaskState } from '../taskBatch.js';

/** Mission portée par une tentative ; les tentatives héritées des runs V2 valent IMPLEMENT. */
export type AttemptMission = 'IMPLEMENT' | 'REVIEW' | 'CORRECT';

/** Phase logique d'une tâche, dérivée du journal des tentatives — jamais stockée. */
export type DerivedPhase = 'implementation' | 'review' | 'correction' | 'accepted' | 'blocked';

/** Journal des tentatives : unique source de vérité de la mission et de la phase d'une tâche. */
export function attemptMission(attempt: BatchTaskAttempt): AttemptMission {
  return attempt.mission ?? 'IMPLEMENT';
}

/** Dérive la phase logique et le compteur de corrections d'une tâche depuis son journal de tentatives.
 * Partagé par status, le contrôleur et les tests : aucun compteur n'est stocké dans le snapshot. */
export function deriveTaskProgress(task: BatchTaskState, maxCorrections: number): { phase: DerivedPhase; corrections: number; correctionsRemaining: number } {
  const corrections = task.attempts.filter(attempt => attemptMission(attempt) === 'CORRECT').length;
  const last = task.attempts.at(-1);
  const missions = task.attempts.map(attemptMission);
  let phase: DerivedPhase;
  if (task.status === 'succeeded') phase = 'accepted';
  else if (task.status === 'blocked') phase = 'blocked';
  else if (task.status === 'failed' && corrections >= maxCorrections) phase = 'blocked';
  else if (missions.at(-1) === 'REVIEW') phase = 'review';
  else if (missions.includes('CORRECT')) phase = 'correction';
  else if (missions.includes('REVIEW')) phase = 'review';
  else phase = 'implementation';
  return { phase, corrections, correctionsRemaining: Math.max(0, maxCorrections - corrections) };
}
