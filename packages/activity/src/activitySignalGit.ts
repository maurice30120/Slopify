import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { truncatePhrase } from './activitySignalText.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 5000;
const MAX_LISTED_NAMES = 3;
const MAX_NAME_LENGTH = 50;

const CATEGORY_ORDER = ['modified', 'created', 'deleted', 'renamed'] as const;

type Category = (typeof CATEGORY_ORDER)[number];

/** L'état `git status --porcelain` du clone d'une tentative, observable entre deux ticks du Signal d'activité. */
export interface ActivityGitSnapshot {
  readonly clonePath: string;
  readonly statuses: Readonly<Record<string, string>>;
}

/** Phrase mécanique du delta, ou null (« pas de delta ») ; snapshot null si la commande git a échoué. */
export interface ActivityGitSignal {
  readonly phrase: string | null;
  readonly snapshot: ActivityGitSnapshot | null;
}

/**
 * Capture le delta `git status` du clone de la tentative, côté hôte, sans jamais lever d'exception.
 * Seul un snapshot du même clone compte comme signal précédent : celui d'une autre tentative est ignoré.
 */
export async function extractActivityGitSignal(
  clonePath: string,
  previous: ActivityGitSnapshot | null,
): Promise<ActivityGitSignal> {
  const statuses = await readStatuses(clonePath);
  if (statuses === null) return { phrase: null, snapshot: null };
  const snapshot: ActivityGitSnapshot = { clonePath, statuses };
  const previousStatuses = previous !== null && previous.clonePath === clonePath ? previous.statuses : {};
  const delta = computeDelta(statuses, previousStatuses);
  return { phrase: delta.size === 0 ? null : describeDelta(delta), snapshot };
}

/** Fichiers dont le statut a changé depuis le signal précédent : nouveaux, modifiés ou reclassés. */
function computeDelta(current: Readonly<Record<string, string>>, previous: Readonly<Record<string, string>>): Map<string, string> {
  const delta = new Map<string, string>();
  for (const [file, xy] of Object.entries(current)) {
    if (previous[file] !== xy) delta.set(file, xy);
  }
  return delta;
}

/** Traduit un code porcelain XY en categorie de phrase, selon l'operation la plus visible. */
function categorize(xy: string): Category {
  const [x, y] = xy;
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'D' || y === 'D') return 'deleted';
  if (xy === '??' || x === 'A' || y === 'A') return 'created';
  return 'modified';
}

/** Construit la phrase mécanique sur une ligne, noms tronqués si trop nombreux. */
function describeDelta(delta: ReadonlyMap<string, string>): string {
  const counts = new Map<Category, string[]>([]);
  for (const [file, xy] of delta) {
    const category = categorize(xy);
    counts.set(category, [...(counts.get(category) ?? []), file]);
  }
  const firstCategory = CATEGORY_ORDER.find(category => (counts.get(category) ?? []).length > 0);
  const phrase = CATEGORY_ORDER
    .map(category => describeCategory(category, counts.get(category) ?? [], category === firstCategory))
    .filter(part => part !== null)
    .join(', ');
  const names = [...delta.keys()].sort().map(truncateName);
  const listed = names.slice(0, MAX_LISTED_NAMES).join(', ');
  const remainder = names.length - MAX_LISTED_NAMES;
  const namesPart = remainder > 0 ? `${listed} + ${remainder} autres` : listed;
  return truncatePhrase(`${phrase} (${namesPart})`);
}

const CATEGORY_WORDING: Record<Category, { one: string; many: string }> = {
  modified: { one: 'modifié', many: 'modifiés' },
  created: { one: 'créé', many: 'créés' },
  deleted: { one: 'supprimé', many: 'supprimés' },
  renamed: { one: 'renommé', many: 'renommés' },
};

function describeCategory(category: Category, files: string[], first: boolean): string | null {
  if (files.length === 0) return null;
  const wording = files.length === 1 ? CATEGORY_WORDING[category].one : CATEGORY_WORDING[category].many;
  const noun = first ? (files.length === 1 ? 'fichier ' : 'fichiers ') : '';
  return `${files.length} ${noun}${wording}`;
}

function truncateName(file: string): string {
  const sanitized = file.replace(/[\r\n\t]/g, ' ');
  return sanitized.length > MAX_NAME_LENGTH ? `${sanitized.slice(0, MAX_NAME_LENGTH)}…` : sanitized;
}

/** Lit le statut porcelain du clone ; null en cas d'échec quelconque de la commande git. */
async function readStatuses(clonePath: string): Promise<Record<string, string> | null> {
  try {
    const result = await execFileAsync('git', ['-C', clonePath, 'status', '--porcelain'], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return parsePorcelain(result.stdout);
  } catch {
    return null;
  }
}

/** Analyse la sortie porcelain : « XY chemin », avec la cible pour les renommages « XY ancien -> nouveau ». */
function parsePorcelain(stdout: string): Record<string, string> {
  const statuses: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const xy = line.slice(0, 2);
    let file = line.slice(3);
    const renameSeparator = file.indexOf(' -> ');
    if (renameSeparator !== -1) file = file.slice(renameSeparator + 4);
    if (file.startsWith('"') && file.endsWith('"')) {
      file = file.slice(1, -1).replace(/\\(["\\])/g, '$1');
    }
    statuses[file] = xy;
  }
  return statuses;
}
