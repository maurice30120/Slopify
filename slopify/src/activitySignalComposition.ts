/**
 * Composition du Signal d'activité (ADR 0013) : module pur qui assemble un
 * Signal complet au contrat figé v1 à partir des candidats par tâche, de
 * l'état « dernier signal émis » par tâche et de la phase d'intégration.
 */

import type { ActivityGroupedSignal, ActivitySignal, ActivityTaskSignal } from './activitySignal.js';

/** Source d'une phrase qui a du nouveau : log de la tentative ou delta git du clone. */
export type ActivityNewsSource = 'log' | 'git';

/** Candidat de Signal d'activité pour une tâche active : du nouveau (phrase + source), ou l'absence de nouvelles. */
export type ActivityTaskCandidate =
  | { taskId: string; news: { sentence: string; source: ActivityNewsSource } }
  | { taskId: string; noNews: true; /** Instant du dernier signal connu de la tentative courante de la tâche. */ lastSignalAt?: Date };

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
  const quiet: Extract<ActivityTaskCandidate, { noNews: true }>[] = [];
  for (const candidate of input.tasks) {
    if ('news' in candidate) {
      if (!signaledWithinSameMinute(input, candidate.taskId)) {
        tasks.push({ taskId: candidate.taskId, sentence: candidate.news.sentence, source: candidate.news.source });
      }
    } else {
      quiet.push(candidate);
    }
  }
  const grouped = quiet.length > 0 ? groupedSignal(input, quiet) : undefined;
  const integration = input.integration !== undefined ? { sentence: input.integration.sentence } : undefined;
  return {
    version: 1,
    runId: input.runId,
    timestamp: input.now.toISOString(),
    tasks,
    ...(grouped !== undefined ? { grouped } : {}),
    ...(integration !== undefined ? { integration } : {}),
  };
}

/** Une seule phrase partagée pour toutes les tâches actives sans nouvelles. */
function groupedSignal(input: ComposeActivitySignalInput, quiet: Extract<ActivityTaskCandidate, { noNews: true }>[]): ActivityGroupedSignal {
  let minutes = 0;
  for (const candidate of quiet) {
    const lastSignalAt = candidate.lastSignalAt;
    if (lastSignalAt !== undefined) {
      minutes = Math.max(minutes, Math.floor((input.now.getTime() - lastSignalAt.getTime()) / 60_000));
    }
  }
  const silence = Math.max(1, minutes);
  return { taskIds: quiet.map(candidate => candidate.taskId), sentence: `rien de nouveau depuis ${silence} minute${silence > 1 ? 's' : ''}`, source: 'none' };
}

/** Bornage ADR : au plus une phrase par tâche et par minute, depuis l'état « dernier signal émis ». */
function signaledWithinSameMinute(input: ComposeActivitySignalInput, taskId: string): boolean {
  const lastSignalAt = input.lastSignalAtByTask?.[taskId];
  if (lastSignalAt === undefined) return false;
  return minuteOf(lastSignalAt) === minuteOf(input.now);
}

function minuteOf(instant: Date): number {
  return Math.floor(instant.getTime() / 60_000);
}
