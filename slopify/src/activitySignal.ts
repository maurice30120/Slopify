/**
 * Contrat du Signal d'activité (ADR 0013) : phrase courte émise périodiquement
 * pendant un run pour informer l'Agent Hôte, entre deux transitions d'état durable.
 */

/** Origine mécanique de la phrase : log de la tentative, delta git du clone, ou rien de nouveau. */
export type ActivitySignalSource = 'log' | 'git' | 'none';

/** Une phrase pour une tâche active qui a du nouveau (une phrase max par tâche et par minute). */
export interface ActivityTaskSignal {
  taskId: string;
  sentence: string;
  source: ActivitySignalSource;
}

/** Une seule phrase regroupant les tâches actives sans nouvelles. */
export interface ActivityGroupedSignal {
  taskIds: string[];
  sentence: string;
  source: 'none';
}

/** Une phrase pour une phase d'intégration de vague. */
export interface ActivityIntegrationSignal {
  sentence: string;
}

/** Contrat fonctionnel du Signal d'activité ; il définit les données et invariants observables. */
export interface ActivitySignal {
  version: 1;
  runId: string;
  timestamp: string;
  tasks: ActivityTaskSignal[];
  grouped?: ActivityGroupedSignal;
  integration?: ActivityIntegrationSignal;
}

/** Type de l'événement JSON dédié émis sur stderr en mode --json, distinct des événements `progress`. */
export const ACTIVITY_SIGNAL_EVENT_TYPE = 'activity-signal';

/** Événement JSON dédié, un objet par ligne sur stderr ; porte le signal complet du tick minute. */
export interface ActivitySignalEvent {
  type: typeof ACTIVITY_SIGNAL_EVENT_TYPE;
  runId: string;
  signal: ActivitySignal;
}

/** Enveloppe un Signal d'activité dans l'événement stderr dédié. */
export function activitySignalEvent(signal: ActivitySignal): ActivitySignalEvent {
  return { type: ACTIVITY_SIGNAL_EVENT_TYPE, runId: signal.runId, signal };
}

/** Sérialise l'événement dédié en une seule ligne JSON, sans saut de ligne final. */
export function formatActivitySignalEvent(signal: ActivitySignal): string {
  return JSON.stringify(activitySignalEvent(signal));
}

const sources: readonly ActivitySignalSource[] = ['log', 'git', 'none'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseTaskSignal(value: unknown): ActivityTaskSignal | undefined {
  if (!isRecord(value)) return undefined;
  const { taskId, sentence, source } = value;
  if (!isNonEmptyString(taskId) || typeof sentence !== 'string') return undefined;
  if (typeof source !== 'string' || !sources.includes(source as ActivitySignalSource)) return undefined;
  return { taskId, sentence, source: source as ActivitySignalSource };
}

/**
 * Valide une valeur comme Signal d'activité ; renvoie undefined pour tout
 * document qui ne respecte pas le contrat figé.
 */
export function parseActivitySignal(value: unknown): ActivitySignal | undefined {
  if (!isRecord(value)) return undefined;
  const { version, runId, timestamp, tasks, grouped, integration } = value;
  if (version !== 1) return undefined;
  if (!isNonEmptyString(runId) || typeof timestamp !== 'string' || !Array.isArray(tasks)) return undefined;
  const parsedTasks: ActivityTaskSignal[] = [];
  for (const task of tasks) {
    const parsed = parseTaskSignal(task);
    if (!parsed) return undefined;
    parsedTasks.push(parsed);
  }
  let parsedGrouped: ActivityGroupedSignal | undefined;
  if (grouped !== undefined) {
    if (!isRecord(grouped)) return undefined;
    const { taskIds, sentence, source } = grouped;
    if (!Array.isArray(taskIds) || taskIds.length === 0 || !taskIds.every(isNonEmptyString)) return undefined;
    if (typeof sentence !== 'string' || source !== 'none') return undefined;
    parsedGrouped = { taskIds, sentence, source: 'none' };
  }
  let parsedIntegration: ActivityIntegrationSignal | undefined;
  if (integration !== undefined) {
    if (!isRecord(integration) || typeof integration.sentence !== 'string') return undefined;
    parsedIntegration = { sentence: integration.sentence };
  }
  return { version: 1, runId, timestamp, tasks: parsedTasks, ...(parsedGrouped ? { grouped: parsedGrouped } : {}), ...(parsedIntegration ? { integration: parsedIntegration } : {}) };
}
