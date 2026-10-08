import type { PipelinePauseFormat, PipelinePauseType } from './PipelineV3Types';

/** Type métier PipelineStatus utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type PipelineStatus =
  | 'planning'
  | 'awaiting_approval'
  | 'implementing'
  | 'reviewing'
  | 'testing'
  | 'completed'
  | 'rejected'
  | 'error'
  | 'cancelled';

/** Contrat fonctionnel de PipelineStatusEvent dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineStatusEvent {
  sessionId: string;
  status: PipelineStatus;
  message: string;
  stepId?: string;
  branchId?: string;
  role?: string;
  agentName?: string;
  implementerUsesSandbox?: boolean;
}

/** Contrat fonctionnel de PipelinePauseEvent dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelinePauseEvent {
  sessionId: string;
  pauseId: string;
  pauseType: PipelinePauseType;
  content: string;
  format: PipelinePauseFormat;
  stepId: string;
  role?: string;
  agentName?: string;
  implementerUsesSandbox?: boolean;
  revised?: boolean;
}

