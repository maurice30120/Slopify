import type {
  SandcastleAgentConfig,
  SandcastleEffort,
  SandcastlePromotion,
  SandcastleProvider,
} from '@acp-client/sandcastle';
import type {
  PipelineChangeSetPreview,
  SandboxAgentConfig,
} from '@acp-client/sandbox';

export type {
  SandcastleAgentConfig,
  SandcastleEffort,
  SandcastlePromotion,
  SandcastleProvider,
} from '@acp-client/sandcastle';
export type { SandboxAgentConfig } from '@acp-client/sandbox';

export interface NativeAcpAgentConfig {
  transport?: 'acp';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  loginShell?: boolean;
  displayName?: string;
  use_idea_mcp?: boolean;
  use_custom_mcp?: boolean;
  skills?: boolean;
}

export type AgentConfigEntry = NativeAcpAgentConfig | SandboxAgentConfig | SandcastleAgentConfig;

export interface RuntimeTimeoutConfig {
  initializeMs?: number;
  newSessionMs?: number;
  authenticateMs?: number;
  promptMs?: number;
  permissionMs?: number;
  authUiMs?: number;
  promotionUiMs?: number;
}

export interface RuntimePipelineConfig {
  enabled: boolean;
  instructionsMaxBytes: number;
  timeouts?: RuntimeTimeoutConfig;
}

export interface AcpRuntimeConfig {
  filePath: string;
  agents: Record<string, NativeAcpAgentConfig | SandboxAgentConfig>;
  pipeline: RuntimePipelineConfig;
  errors: string[];
}

export interface SandcastleConfig {
  filePath: string;
  promotion: SandcastlePromotion;
  agents: Record<string, SandcastleAgentConfig>;
  errors: string[];
}

export interface AgentCatalog {
  native: AcpRuntimeConfig;
  sandcastle: SandcastleConfig;
  agents: Record<string, AgentConfigEntry>;
  errors: string[];
}

export interface RuntimeUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message?: string): Promise<boolean>;
}

export interface RuntimePermissionContext {
  hasUI: boolean;
  ui: RuntimeUi;
}

/**
 * Contrat de l'hôte pour composer le workspace.
 * L'hôte fournit les décisions d'interface, les permissions et la journalisation.
 */
export interface WorkspaceRuntimeHost {
  permissionContext(): RuntimePermissionContext | undefined;
  requestPromotion(request: SandcastlePromotionRequest): Promise<SandcastlePromotionDecision>;
  requestPipelinePromotion?(
    request: PipelineChangeSetPromotionRequest,
  ): Promise<SandcastlePromotionDecision>;
  logger: Logger;
}

export type SandcastlePromotionDecision = 'approve' | 'reject' | 'cancelled';

export interface SandcastlePromotionRequest {
  agentName: string;
  sessionId: string;
  preview: SandcastlePreview;
}

export interface SandcastlePreview {
  diff: string;
  filesChanged: number;
  branch: string;
  baseRef: string;
  worktreePath: string;
}

export interface PipelineChangeSetPromotionRequest {
  runId: string;
  pipelineId: string;
  integratedNodeIds: string[];
  preview: PipelineChangeSetPreview;
}

export interface Logger {
  log(message: string): void;
  error(message: string, error?: unknown): void;
}

export const consoleLogger: Logger = {
  log(message) { console.log(`[acp-workspace] ${message}`); },
  error(message, error) {
    if (error === undefined) console.error(`[acp-workspace] ${message}`);
    else console.error(`[acp-workspace] ${message}`, error);
  },
};

/**
 * Options de création d'un WorkspaceRuntime.
 */
export interface WorkspaceRuntimeOptions {
  workspaceCwd: string;
  host: WorkspaceRuntimeHost;
}
