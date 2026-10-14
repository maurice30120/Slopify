/**
 * Horloge et lecture du tick d'activité (ADR 0013). Le tick minute vit dans le
 * service d'exécution ; l'horloge est injectée aux options du service pour un
 * rythme testable, et la lecture du log de la tentative ne consomme que ce que
 * l'exécuteur a appended depuis le tick précédent. Aucune lecture ne sort
 * d'ici qui puisse interrompre l'exécution d'une tâche.
 */

import { open, type FileHandle } from 'node:fs/promises';

/** Horloge du tick d'activité : instant courant et attente entre deux ticks. */
export interface ActivityTickClock {
  now(): Date;
  /** Attend le prochain tick ; revient immédiatement quand `signal` est interrompu. */
  wait(intervalMs: number, signal: AbortSignal): Promise<void>;
}

/** Horloge système du tick minute : Date courante et setTimeout interrompu par l'annulation. */
export function createSystemActivityTickClock(): ActivityTickClock {
  return {
    now: () => new Date(),
    wait: (intervalMs, signal) => new Promise<void>(resolve => {
      if (signal.aborted) { resolve(); return; }
      const settle = () => { clearTimeout(timer); signal.removeEventListener('abort', settle); resolve(); };
      const timer = setTimeout(settle, intervalMs);
      signal.addEventListener('abort', settle, { once: true });
    }),
  };
}

/** Ce que le log de la tentative a gagné depuis l'offset du tick précédent. */
export interface AttemptLogTail {
  text: string;
  offset: number;
}

/**
 * Lit le nouveau texte du log stdout de la tentative depuis `offset` ;
 * `undefined` si le fichier est illisible. Un log recréé plus court relance la
 * lecture depuis le début pour ne jamais rater de contenu.
 */
export async function readAttemptLogTail(logPath: string, offset: number): Promise<AttemptLogTail | undefined> {
  let handle: FileHandle;
  try { handle = await open(logPath, 'r'); } catch { return undefined; }
  try {
    const size = (await handle.stat()).size;
    const start = offset > size ? 0 : offset;
    if (start >= size) return { text: '', offset: size };
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return { text: buffer.toString('utf8'), offset: size };
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}
