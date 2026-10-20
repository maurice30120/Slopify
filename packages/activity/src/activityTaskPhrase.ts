/**
 * Chaîne de sources par tâche du Signal d'activité (ADR 0013) : phrase mécanique
 * pour une tâche active, en ordre de priorité — dernière ligne significative du
 * log de la tentative, à défaut delta git du clone, à défaut « rien de nouveau
 * depuis N minutes ». Module pur : les lectures (log, delta git, instants)
 * arrivent par les entrées, une panne représentée en entrée retombe sur l'étage
 * suivant, et rien ne sort d'ici qui puisse interrompre une tâche.
 */
import type { ActivityTaskSignal } from './activitySignal.js';
import type { ActivityGitSignal } from './activitySignalGit.js';
import { activityPhraseFromAttemptLog, nothingNewSincePhrase } from './activitySignalLogPhrase.js';

/** Entrées du chaînage : le log stdout de la tentative, le delta git de son clone, les instants. */
export interface ActivityTaskPhraseInput {
  taskId: string;
  /** Log stdout de la tentative ; `undefined` si la lecture a échoué. */
  log: string | undefined;
  /** Delta git du clone de la tentative (sortie d'`activitySignalGit`) ; `undefined` si la lecture a échoué. */
  git: ActivityGitSignal | undefined;
  /** Instant courant. */
  now: Date;
  /** Instant du dernier signal connu de la même tentative. */
  lastSignalAt?: Date;
}

/** Produit la phrase d'une tâche active en enchaînant les étages dans l'ordre de l'ADR 0013. */
export function activityTaskPhrase(input: ActivityTaskPhraseInput): ActivityTaskSignal {
  let taskId = '';
  try {
    taskId = typeof input.taskId === 'string' ? input.taskId : '';
    const fromLog = phraseFromLog(input);
    if (fromLog !== undefined) return { taskId, sentence: fromLog, source: 'log' };
    const fromGit = phraseFromGit(input);
    if (fromGit !== undefined) return { taskId, sentence: fromGit, source: 'git' };
    return { taskId, sentence: rienDeNouveau(input), source: 'none' };
  } catch {
    // Repli cataclysmique sans toucher aux entrées : un getter piégé ne doit rien
    // faire fuir du module. L'identifiant déjà lu survit ; un getter piégé
    // laisse la chaîne vide.
    return { taskId, sentence: nothingNewSincePhrase(new Date(), undefined), source: 'none' };
  }
}

/** Étage 1 : la dernière ligne significative du log ; `undefined` si le log est silencieux ou illisible. */
function phraseFromLog(input: ActivityTaskPhraseInput): string | undefined {
  if (typeof input.log !== 'string') return undefined;
  return activityPhraseFromAttemptLog({ log: input.log, now: input.now });
}

/** Étage 2 : la phrase du delta git du clone ; `undefined` si le clone est intact ou la lecture a échoué. */
function phraseFromGit(input: ActivityTaskPhraseInput): string | undefined {
  const phrase = input.git?.phrase;
  return typeof phrase === 'string' && phrase.length > 0 ? phrase : undefined;
}

/** Étage 3 : « rien de nouveau depuis N minutes » (N ≥ 1), depuis le dernier signal connu de la même tentative. */
function rienDeNouveau(input: ActivityTaskPhraseInput): string {
  return nothingNewSincePhrase(input.now, input.lastSignalAt);
}
