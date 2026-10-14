/**
 * Pure seam for the Activity Signal log source (ADR 0013).
 *
 * Extracts the activity phrase from the stdout log of an attempt: the last
 * significant line, with ANSI escapes stripped, truncated to a single line of
 * at most 200 characters. Falls back to "rien de nouveau depuis N minutes"
 * computed from the last known signal, or undefined when there is nothing to
 * say (the tick then falls back to the Git delta).
 */
export interface ActivityPhraseInput {
  /** Full stdout log of the attempt. */
  log: string;
  /** Current instant. */
  now: Date;
  /** Instant of the last known Activity Signal for the same attempt. */
  lastSignalAt?: Date;
}

/** At most 200 characters total on the phrase: 199 kept + ellipsis. */
const MAX_PHRASE_LENGTH = 200;

const LETTER_PATTERN = /\p{L}/u;
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function activityPhraseFromAttemptLog(input: ActivityPhraseInput): string | undefined {
  const phrase = lastSignificantLine(input.log);
  if (phrase !== undefined) return phrase;
  if (input.lastSignalAt === undefined) return undefined;
  return nothingNewSincePhrase(input.now, input.lastSignalAt);
}

/**
 * The shared "rien de nouveau depuis N minutes" fallback (N ≥ 1 per the frozen
 * contract), computed from the last known signal of the same attempt.
 */
export function nothingNewSincePhrase(now: Date, lastSignalAt: Date): string {
  const elapsedMinutes = Math.floor((now.getTime() - lastSignalAt.getTime()) / 60_000);
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
  return last === undefined ? undefined : truncate(last);
}

/** Consumes a raw JSON block (single or pretty-printed multi-line) via brace balance. */
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

function truncate(line: string): string {
  return line.length > MAX_PHRASE_LENGTH
    ? `${line.slice(0, MAX_PHRASE_LENGTH - 1)}…`
    : line;
}
