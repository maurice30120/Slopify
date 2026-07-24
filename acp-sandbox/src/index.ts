import type { PromotionPolicy } from './gitPromotion.js';

export {
  GitPromotion,
  IntegrationConflictError,
  PROMOTION_POLICIES,
  SLOPIFY_GIT_EMAIL,
  SLOPIFY_GIT_NAME,
  type AgentCheckpoint,
  type AgentCheckpointPreview,
  type AgentCheckpointResult,
  type CreateAgentCheckpointInput,
  type IntegrateAgentCheckpointsInput,
  type IntegrationConflict,
  type PipelineChangeSet,
  type PipelineChangeSetPreview,
  type PipelineChangeSetResult,
  type PromotePipelineChangeSetInput,
  type PromotionDecider,
  type PromotionDecision,
  type PromotionPolicy,
  type PromotionRequest,
  type PromotionResult,
  type PromotionStatus,
} from './gitPromotion.js';

export {
  DOCKER_SANDBOX_NETWORK_POLICY_CHOICES,
  DockerSandboxRuntime,
  DEFAULT_SANDBOX_CLEANUP_TIMEOUT_MS,
  MINIMUM_SBX_VERSION,
  SandboxRunCancelledError,
  SandboxRunTimeoutError,
  createNodeSubprocessExecutor,
  retainedSandboxCommands,
  stableSandboxName,
  type DockerSandboxNetworkPolicyChoice,
  type DockerSandboxNetworkPolicyPreset,
  type DockerSandboxRuntimeOptions,
  type RetainedSandbox,
  type RetainedSandboxCommands,
  type SandboxCleanupDiagnostic,
  type SandboxRunDiagnostic,
  type SandboxRunInput,
  type SandboxRunResult,
  type SandboxRunTerminalStatus,
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
  promotion: PromotionPolicy;
}
