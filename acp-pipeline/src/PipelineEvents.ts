import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { PipelinePauseFormat, PipelinePauseType } from './PipelineV3Types';

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

export interface PipelinePlanReadyEvent extends Omit<PipelinePauseEvent, 'pauseId' | 'content' | 'format'> {
  plan: string;
}

export interface PipelineSessionUpdateEvent {
  sessionId: string;
  phase: string;
  update: SessionNotification;
  stepId?: string;
  branchId?: string;
  role?: string;
  agentName?: string;
}
