export {
  DockerSandboxAcpBridgeAgent,
  SandboxAcpExtensionAgent,
  type SandboxBridgePreviewResponse,
} from './acpBridge.js';

export {
  SandboxAcpExtensionHandler,
} from './extensions.js';

export {
  GitPromotion,
  IntegrationConflictError,
  type AgentCheckpointResult,
  type IntegrateAgentCheckpointsInput,
  type IntegrationConflict,
  type PipelineChangeSetPreview,
  type PipelineChangeSetResult,
  type PromotePipelineChangeSetInput,
  type PromotionDecision,
  type PromotionResult,
} from './gitPromotion.js';

export {
  DockerSandboxRuntime,
  createNodeSubprocessExecutor,
  stableSandboxName,
  type DockerSandboxNetworkPolicyChoice,
  type RetainedSandbox,
  type SandboxReconciliationResult,
  type SandboxResumeSnapshot,
  type SandboxRunState,
  type SubprocessExecutor,
  type SubprocessRequest,
  type SubprocessResult,
} from './runtime.js';

/** Contrat fonctionnel de SandboxAgentConfig dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface SandboxAgentConfig {
  transport: 'sandbox';
  agent: SandboxAgent;
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  displayName?: string;
  skills?: boolean;
}

/** CLI d'agent pris en charge dans un Docker Sandbox. */
export type SandboxAgent = 'codex' | 'vibe';
