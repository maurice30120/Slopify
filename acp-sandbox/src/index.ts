export {
  GitPromotion,
  SLOPIFY_GIT_EMAIL,
  SLOPIFY_GIT_NAME,
  type AgentCheckpoint,
  type AgentCheckpointPreview,
  type AgentCheckpointResult,
  type CreateAgentCheckpointInput,
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
