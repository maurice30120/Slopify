/**
 * Journal d'activité du run (ADR 0013) : persistance intégrale des Signaux
 * d'activité, une entrée JSON par ligne dans le répertoire du run du store.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parseActivitySignal, type ActivitySignal } from './activitySignal.js';

/** Nom du fichier journal dans le répertoire du run, à côté de state.json. */
export const ACTIVITY_JOURNAL_FILE = 'activity.jsonl';

/** Chemin du journal d'activité du run dans le store : <store>/<runId>/activity.jsonl. */
export function activityJournalPath(storePath: string, runId: string): string {
  return path.join(storePath, runId, ACTIVITY_JOURNAL_FILE);
}

/**
 * Lit la fenêtre des `last` derniers Signaux d'activité du journal, en ordre
 * d'émission. Tolérant par contrat : journal absent ou illisible → fenêtre
 * vide, jamais d’exception ; les lignes déchirées ou étrangères sont ignorées.
 * `last` vaut 10 par défaut (fenêtre de `tasks status`) ; 0 ou négatif renvoie
 * tout le journal.
 */
export async function readActivitySignals(journalPath: string, last = 10): Promise<ActivitySignal[]> {
  let contents: string;
  try {
    contents = await readFile(journalPath, 'utf8');
  } catch {
    return [];
  }
  const signals: ActivitySignal[] = [];
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const signal = parseActivitySignal(parsed);
    if (signal) signals.push(signal);
  }
  return last > 0 ? signals.slice(-last) : signals;
}

// Sérialise les ajouts vers un même fichier : un append ne démarre qu'après le
// précédent terminé, pour qu'aucune entrée n'en tronque une autre.
const appends = new Map<string, Promise<void>>();

/**
 * Ajoute un Signal d'activité au journal du run : une entrée JSON par ligne,
 * ajout atomique qui ne corrompt jamais les entrées précédentes.
 */
export async function appendActivitySignal(journalPath: string, signal: ActivitySignal): Promise<void> {
  const previous = appends.get(journalPath)?.catch(() => {}) ?? Promise.resolve();
  const current = previous.then(async () => {
    await mkdir(path.dirname(journalPath), { recursive: true, mode: 0o700 });
    await appendFile(journalPath, `${JSON.stringify(signal)}\n`, { mode: 0o600 });
  });
  appends.set(journalPath, current);
  try {
    await current;
  } finally {
    if (appends.get(journalPath) === current) appends.delete(journalPath);
  }
}
