/**
 * Composition du Signal d'activité (ADR 0013) : module pur qui assemble un
 * Signal complet au contrat figé v1 à partir des candidats par tâche, de
 * l'état « dernier signal émis » par tâche et de la phase d'intégration.
 */

import type { ActivitySignal, ActivityTaskSignal } from './activitySignal.js';

/** Source d'une phrase qui a du nouveau : log de la tentative ou delta git du clone. */
export type ActivityNewsSource = 'log' | 'git';

/** Candidat de Signal d'activité pour une tâche active : du nouveau (phrase + source), ou l'absence de nouvelles. */
export type ActivityTaskCandidate =
  | { taskId: string; news: { sentence: string; source: ActivityNewsSource } }
  | { taskId: string; noNews: true };

/** Phase d'intégration de vague courante, avec sa phrase. */
export interface ActivityIntegrationInput {
  sentence: string;
}

/** Entrées de la composition : candidats par tâche, état « dernier signal émis », phase d'intégration. */
export interface ComposeActivitySignalInput {
  runId: string;
  now: Date;
  tasks: ActivityTaskCandidate[];
  /** Instant de la dernière phrase émise pour chaque tâche (bornage : une phrase max par tâche et par minute). */
  lastSignalAtByTask?: Readonly<Record<string, Date>>;
  integration?: ActivityIntegrationInput;
}

/** Compose un Signal d'activité complet au contrat figé v1. */
export function composeActivitySignal(input: ComposeActivitySignalInput): ActivitySignal {
  const tasks: ActivityTaskSignal[] = [];
  for (const candidate of input.tasks) {
    if ('news' in candidate) {
      tasks.push({ taskId: candidate.taskId, sentence: candidate.news.sentence, source: candidate.news.source });
    }
  }
  return {
    version: 1,
    runId: input.runId,
    timestamp: input.now.toISOString(),
    tasks,
  };
}
