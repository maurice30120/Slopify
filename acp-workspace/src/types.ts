import type {
  PipelineChangeSetPreview,
  SandboxAgentConfig,
} from '@acp-client/sandbox';

export type { SandboxAgentConfig } from '@acp-client/sandbox';

/** Contrat fonctionnel de NativeAcpAgentConfig dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
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

/** Type métier AgentConfigEntry utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type AgentConfigEntry = NativeAcpAgentConfig | SandboxAgentConfig;

/** Contrat fonctionnel de RuntimeTimeoutConfig dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface RuntimeTimeoutConfig {
  initializeMs?: number;
  newSessionMs?: number;
  authenticateMs?: number;
  promptMs?: number;
  permissionMs?: number;
  authUiMs?: number;
  promotionUiMs?: number;
}

/** Contrat fonctionnel de RuntimePipelineConfig dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface RuntimePipelineConfig {
  enabled: boolean;
  instructionsMaxBytes: number;
  timeouts?: RuntimeTimeoutConfig;
}

/** Contrat fonctionnel de AcpRuntimeConfig dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface AcpRuntimeConfig {
  filePath: string;
  agents: Record<string, NativeAcpAgentConfig | SandboxAgentConfig>;
  pipeline: RuntimePipelineConfig;
  errors: string[];
}

/** Contrat fonctionnel de AgentCatalog dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface AgentCatalog {
  config: AcpRuntimeConfig;
  agents: Record<string, AgentConfigEntry>;
  errors: string[];
}

/** Contrat fonctionnel de RuntimeUi dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface RuntimeUi {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  select(title: string, options: string[]): Promise<string | undefined>;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  confirm(title: string, message?: string): Promise<boolean>;
  write?(message: string): void;
}

/** Contrat fonctionnel de RuntimePermissionContext dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface RuntimePermissionContext {
  hasUI: boolean;
  ui: RuntimeUi;
}

/**
 * Contrat de l'hôte pour composer le workspace.
 * L'hôte fournit les décisions d'interface, les permissions et la journalisation.
 */
export interface WorkspaceRuntimeHost {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  permissionContext(): RuntimePermissionContext | undefined;
  requestPipelinePromotion?(
    request: PipelineChangeSetPromotionRequest,
  ): Promise<SandboxPromotionDecision>;
  logger: Logger;
}

/** Type métier SandboxPromotionDecision utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type SandboxPromotionDecision = 'approve' | 'reject' | 'cancelled';

/** Contrat fonctionnel de PipelineChangeSetPromotionRequest dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineChangeSetPromotionRequest {
  runId: string;
  pipelineId: string;
  integratedNodeIds: string[];
  preview: PipelineChangeSetPreview;
}

/** Contrat fonctionnel de Logger dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface Logger {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  log(message: string): void;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  error(message: string, error?: unknown): void;
}

/** Constante consoleLogger qui fixe un contrat partagé du pipeline. */
export const consoleLogger: Logger = {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  log(message) { console.log(`[acp-workspace] ${message}`); },
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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
  /** Agent choisi par l'hôte pour chaque nœud agent du pipeline. */
  agentName?: string;
  host: WorkspaceRuntimeHost;
}
