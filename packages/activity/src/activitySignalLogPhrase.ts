import { truncatePhrase } from './activitySignalText.js';

/**
 * Seam pur de la source log du Signal d'activité (ADR 0013).
 *
 * Extrait la phrase d'activité depuis le log stdout d'une tentative : la
 * dernière ligne significative, codes ANSI retirés, tronquée sur une seule
 * ligne d'au plus 200 caractères. Repli « rien de nouveau depuis N minutes »
 * calculé depuis le dernier signal connu, ou undefined quand il n'y a rien à
 * dire (le tick retombe alors sur le delta Git).
 */
export interface ActivityPhraseInput {
  /** Log stdout complet de la tentative. */
  log: string;
  /** Instant courant. */
  now: Date;
  /** Instant du dernier Signal d'activité connu pour la même tentative. */
  lastSignalAt?: Date;
}

const LETTER_PATTERN = /\p{L}/u;
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function activityPhraseFromAttemptLog(input: ActivityPhraseInput): string | undefined {
  const phrase = lastSignificantLine(input.log);
  if (phrase !== undefined) return phrase;
  if (input.lastSignalAt === undefined) return undefined;
  return nothingNewSincePhrase(input.now, input.lastSignalAt);
}

/**
 * Repli partagé « rien de nouveau depuis N minutes » (N ≥ 1 selon le contrat
 * figé), calculé depuis le dernier signal connu de la même tentative. Un
 * instant de référence manquant ou invalide donne la formulation N = 1 —
 * la chaîne et la composition partagent cette convention, pour que le
 * libellé de l'US 5 ne perde jamais sa durée.
 */
export function nothingNewSincePhrase(now: Date, lastSignalAt: Date | undefined): string {
  const elapsedMinutes = lastSignalAt instanceof Date && Number.isFinite(lastSignalAt.getTime())
    && now instanceof Date && Number.isFinite(now.getTime())
    ? Math.floor((now.getTime() - lastSignalAt.getTime()) / 60_000)
    : 0;
  const minutes = Math.max(1, elapsedMinutes);
  return `rien de nouveau depuis ${minutes} minute${minutes > 1 ? 's' : ''}`;
}

function lastSignificantLine(log: string): string | undefined {
  if (typeof log !== 'string' || log.length === 0) return undefined;
  const lines = log.split(/\r?\n/);
  let last: string | undefined;
  let index = 0;
  while (index < lines.length) {
    const line = stripAnsi(lines[index]).trim();
    if (line.length === 0) {
      index++;
    } else if (line.startsWith('{') || line.startsWith('[')) {
      index = endOfJsonBlock(lines, index);
    } else if (LETTER_PATTERN.test(line)) {
      last = line;
      index++;
    } else {
      index++;
    }
  }
  return last === undefined ? undefined : truncatePhrase(last);
}

/** Consomme un bloc JSON brut (mono-ligne ou pretty-printé multi-lignes) par balance d'accolades. */
function endOfJsonBlock(lines: string[], start: number): number {
  let depth = 0;
  for (let index = start; index < lines.length; index++) {
    for (const character of stripAnsi(lines[index])) {
      if (character === '{' || character === '[') depth++;
      else if (character === '}' || character === ']') depth--;
    }
    if (depth <= 0) return index + 1;
  }
  return lines.length;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}
