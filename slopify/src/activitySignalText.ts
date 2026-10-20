/**
 * Troncature partagée des phrases du Signal d'activité (ADR 0013) : 199
 * caractères conservés + « … », une seule ligne — borne commune aux étages
 * log et git de la chaîne de sources.
 */

/** Borne totale de la phrase : 200 caractères, points de suspension compris. */
export const MAX_PHRASE_LENGTH = 200;

/** Tronque sur une seule ligne : 199 caractères conservés + « … » au-delà de la borne. */
export function truncatePhrase(line: string): string {
  return line.length > MAX_PHRASE_LENGTH
    ? `${line.slice(0, MAX_PHRASE_LENGTH - 1)}…`
    : line;
}
