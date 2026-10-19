import type { BatchTaskState } from '../taskBatch.js';

/** Taille maximale d'une vague de travail, conservée du moteur V2. */
export const WAVE_SIZE = 10;

/** Sélectionne les tickets prêts : pending dont toutes les dépendances sont succeeded.
 * À priorité égale, préfère le ticket qui débloque le plus de descendants directs,
 * puis conserve l'ordre stable du JSON. Mécanique pure : aucun LLM. */
export function selectReadyWave(tasks: BatchTaskState[]): BatchTaskState[] {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const ready = tasks.filter(task => task.status === 'pending'
    && task.dependsOn.every(id => byId.get(id)?.status === 'succeeded'));
  const descendants = (id: string) => tasks.filter(other => other.dependsOn.includes(id)).length;
  ready.sort((a, b) => descendants(b.id) - descendants(a.id));
  return ready.slice(0, WAVE_SIZE);
}

/** Marque les descendants d'une tâche en échec comme bloqués, en cascade. */
export function blockDescendants(tasks: BatchTaskState[]): void {
  const byId = new Map(tasks.map(task => [task.id, task]));
  let changed: boolean;
  do {
    changed = false;
    for (const task of tasks) {
      if (task.status !== 'pending') continue;
      const blockedBy = task.dependsOn.filter(id => ['failed', 'interrupted', 'blocked'].includes(byId.get(id)!.status));
      if (blockedBy.length) { task.status = 'blocked'; task.blockedBy = blockedBy; changed = true; }
    }
  } while (changed);
}
