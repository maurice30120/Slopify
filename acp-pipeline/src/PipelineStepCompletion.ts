export type PipelinePromotionStatus = 'applied' | 'no_changes' | 'rejected' | 'cancelled';

export interface PipelinePromotedRunResult {
  text: string;
  promotion?: PipelinePromotionStatus;
}

export type PipelineStepRunResult = string | PipelinePromotedRunResult;

export class PipelineStepRejectedError extends Error {
  constructor() {
    super('Pipeline step rejected.');
  }
}

export class PipelineStepCancelledError extends Error {
  constructor() {
    super('Pipeline step cancelled.');
  }
}

/**
 * Converts adapter-specific run output into the PipelineStep interface.
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

export function isPipelineStepRejected(error: unknown): error is PipelineStepRejectedError {
  return error instanceof PipelineStepRejectedError;
}

export function isPipelineStepCancelled(error: unknown): error is PipelineStepCancelledError {
  return error instanceof PipelineStepCancelledError;
}
