export {
  GitPromotion,
  PROMOTION_POLICIES,
  SLOPIFY_GIT_EMAIL,
  SLOPIFY_GIT_NAME,
  type AgentCheckpoint,
  type AgentCheckpointPreview,
  type AgentCheckpointResult,
  type CreateAgentCheckpointInput,
  type PromotePipelineChangeSetInput,
  type PromotionDecider,
  type PromotionDecision,
  type PromotionPolicy,
  type PromotionRequest,
  type PromotionResult,
  type PromotionStatus,
} from './gitPromotion.js';

export {
  DockerSandboxRuntime,
  MINIMUM_SBX_VERSION,
  createNodeSubprocessExecutor,
  stableSandboxName,
  type SandboxRunInput,
  type SandboxRunResult,
  type SubprocessExecutor,
  type SubprocessRequest,
  type SubprocessResult,
} from './runtime.js';

export interface SandboxAgentConfig {
  transport: 'sandbox';
  agent: 'codex';
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  displayName?: string;
  skills?: boolean;
}

export interface SandboxPipelineConfig {
  promotion: import('./gitPromotion.js').PromotionPolicy;
}
