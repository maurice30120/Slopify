import type {
  PipelineChangeSetPreview,
  SandboxAgentConfig,
} from '@acp-client/sandbox';

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

export type AgentConfigEntry = NativeAcpAgentConfig | SandboxAgentConfig;

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

export interface AgentCatalog {
  config: AcpRuntimeConfig;
  agents: Record<string, AgentConfigEntry>;
  errors: string[];
}

export interface RuntimeUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message?: string): Promise<boolean>;
  write?(message: string): void;
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
  requestPipelinePromotion?(
    request: PipelineChangeSetPromotionRequest,
  ): Promise<SandboxPromotionDecision>;
  logger: Logger;
}

export type SandboxPromotionDecision = 'approve' | 'reject' | 'cancelled';

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
