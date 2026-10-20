/** Composant RunAbortedError qui coordonne une étape observable du cycle de vie du pipeline et en préserve les invariants. */
export class RunAbortedError extends Error {
  readonly name = 'RunAbortedError';

/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
  constructor(message = 'Run aborted.') {
    super(message);
  }
}

/** Point d'entrée isRunAbortedError du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
export function isRunAbortedError(error: unknown): error is RunAbortedError {
  return error instanceof RunAbortedError
    || (error instanceof Error && error.name === 'RunAbortedError');
}
