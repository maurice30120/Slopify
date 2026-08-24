// Entrées/sorties de la configuration du workspace
export {
  loadAcpConfig,
  parseAcpConfig,
  loadAgentCatalog,
  writeAgentConfigs,
  upsertAgentConfig,
  removeAgentConfig,
} from './config/config.js';

// Catalogues
export {
  getPipelinePrograms,
  getPipelineProgramForAgent,
  loadWorkspacePipelinePrograms,
  loadPipelineProgramsFromRoot,
} from './catalog/pipelineCatalog.js';
export type { PipelineProgramsFromRootOptions } from './catalog/pipelineCatalog.js';

export {
  loadSkillCatalog,
  renderSkillsCatalog,
} from './catalog/skillCatalog.js';
export type { SkillCatalogEntry, SkillCatalogOptions } from './catalog/skillCatalog.js';
export { resolveWorkspaceAgent, listWorkspaceAgentNames } from './catalog/virtualAgentCatalog.js';
export type { AgentResolution } from './catalog/virtualAgentCatalog.js';

// Runtime du workspace
export {
  createWorkspaceRuntime,
  type WorkspaceRuntime,
  type CreateWorkspaceRuntimeOptions,
  type WorkspaceConnectorOverrides,
} from './runtime/workspaceRuntime.js';
export {
  createWorkspaceRun,
  type CreateWorkspaceRunOptions,
  type HostInteraction,
  type WorkspaceArtifact,
  type WorkspaceRun,
  type WorkspaceRunBackend,
  type WorkspaceRunInteraction,
  type WorkspaceRunOutcome,
} from './run/workspaceRunPolicy.js';

// Types
export type {
  NativeAcpAgentConfig,
  AgentConfigEntry,
  RuntimeTimeoutConfig,
  RuntimePipelineConfig,
  AcpRuntimeConfig,
  AgentCatalog,
  RuntimeUi,
  RuntimePermissionContext,
  Logger,
  SandboxPromotionDecision,
  PipelineChangeSetPromotionRequest,
  SandboxAgentConfig,
  WorkspaceRuntimeOptions,
} from './types.js';
export { consoleLogger } from './types.js';
