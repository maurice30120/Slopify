/** Type métier PipelinePromotionStatus utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type PipelinePromotionStatus = 'applied' | 'no_changes' | 'rejected' | 'cancelled';

/** Contrat fonctionnel de PipelinePromotedRunResult dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelinePromotedRunResult {
  text: string;
  promotion?: PipelinePromotionStatus;
}

/** Type métier PipelineStepRunResult utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type PipelineStepRunResult = string | PipelinePromotedRunResult;

/** Composant PipelineStepRejectedError qui coordonne une étape observable du cycle de vie du pipeline et en préserve les invariants. */
export class PipelineStepRejectedError extends Error {
/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
  constructor() {
    super('Pipeline step rejected.');
  }
}

/** Composant PipelineStepCancelledError qui coordonne une étape observable du cycle de vie du pipeline et en préserve les invariants. */
export class PipelineStepCancelledError extends Error {
/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
  constructor() {
    super('Pipeline step cancelled.');
  }
}

/**
 * Préserve l'interface PipelineStep historique malgré les résultats structurés
 * renvoyés par les adaptateurs capables de gérer une Promotion.
 */
export function resolvePipelineStepText(result: PipelineStepRunResult): string {
  if (typeof result === 'string') {
    return result;
  }
  if (result.promotion === 'rejected') {
    throw new PipelineStepRejectedError();
  }
  if (result.promotion === 'cancelled') {
    throw new PipelineStepCancelledError();
  }
  return result.text;
}

/** Point d'entrée isPipelineStepRejected du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
export function isPipelineStepRejected(error: unknown): error is PipelineStepRejectedError {
  return error instanceof PipelineStepRejectedError;
}

/** Point d'entrée isPipelineStepCancelled du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
export function isPipelineStepCancelled(error: unknown): error is PipelineStepCancelledError {
  return error instanceof PipelineStepCancelledError;
}
