import type { NormalizedPipelinePolicy, NormalizedPromotionPolicy } from "./PipelinePolicy";
import type { PipelineIntegrationConflict, PipelineSandboxResumeDivergence } from "./PipelineAgentRunner";
import type { ExecutionPlanSnapshot } from "./ExecutionPlan";

/** Type métier PipelineArtifactFormat utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type PipelineArtifactFormat = "text" | "markdown" | "json";

/** Type métier PipelinePauseType utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type PipelinePauseType = "approval" | "question" | "promotion";

/** Type métier PipelinePauseFormat utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type PipelinePauseFormat = "text" | "markdown" | "json" | "proposed-plan";

/** Contrat fonctionnel de PipelineArtifact dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineArtifact<T = unknown> {
  name: string;
  type: string;
  format: PipelineArtifactFormat;
  value: T;
  producerNodeId: string;
}

/** Contrat fonctionnel de PipelineNodeInputDefinition dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineNodeInputDefinition {
  name: string;
  from: string;
  type?: string;
  format?: PipelineArtifactFormat;
}

/** Contrat fonctionnel de PipelineNodeOutputDefinition dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineNodeOutputDefinition {
  name: string;
  type: string;
  format: PipelineArtifactFormat;
}

/** Contrat fonctionnel de PipelineRetryDefinition dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineRetryDefinition {
  maxAttempts: number;
  backoffMs?: number;
}

/** Contrat fonctionnel de PipelineInteractionDefinition dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineInteractionDefinition {
  protocol: string;
  repairAttempts: number;
}

/** Contrat fonctionnel de PipelinePolicyReference dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelinePolicyReference {
  profile?: string;
  filesystem?: "read-only" | "workspace-write";
  terminal?: "none" | "read-only" | "workspace-write";
  network?: "disabled" | "enabled";
  promotion?: "discard" | "ask" | "auto-apply" | "auto-reject";
}

/** Contrat fonctionnel de PipelineWorkspaceHandoffDefinition dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineWorkspaceHandoffDefinition {
  kind: "workspace-files";
  minimumReferences?: number;
  layout?: "delivery";
}

/** Contrat fonctionnel de PipelineAgentNodeDefinition dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineAgentNodeDefinition {
  id: string;
  type?: "agent";
  /** Surcharge legacy facultative ; l'hôte lie normalement l'agent choisi par la CLI. */
  agent?: string;
  /** Tâche et données propres au run. */
  prompt?: string;
  /** Rôle et règles invariants, chargés séparément de la tâche. */
  instructionsFile?: string;
  /** @deprecated Utiliser `instructionsFile`. */
  promptFile?: string;
  skills?: string[];
  needs?: string[];
  inputs?: PipelineNodeInputDefinition[];
  output: PipelineNodeOutputDefinition;
  retry?: PipelineRetryDefinition;
  interaction?: {
    protocol: string;
    repairAttempts?: number;
  };
  policy?: string | PipelinePolicyReference;
}

/** Contrat fonctionnel de PipelinePauseNodeDefinition dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelinePauseNodeDefinition {
  id: string;
  type: "pause";
  pause: PipelinePauseType;
  content: string;
  format?: PipelinePauseFormat;
  needs?: string[];
  inputs?: PipelineNodeInputDefinition[];
  output?: PipelineNodeOutputDefinition;
  handoff?: PipelineWorkspaceHandoffDefinition;
  workspaceGuard?: "documentation-only";
  interaction?: never;
  policy?: string | PipelinePolicyReference;
}

/** Type métier PipelineNodeDefinition utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type PipelineNodeDefinition =
  | PipelineAgentNodeDefinition
  | PipelinePauseNodeDefinition;

/** Contrat fonctionnel de PipelineV3Definition dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineV3Definition {
  version: 3;
  id: string;
  title: string;
  promotion?: NormalizedPromotionPolicy;
  agents?: Record<string, unknown>;
  policies?: Record<string, PipelinePolicyReference>;
  nodes: PipelineNodeDefinition[];
  source?: "workspace" | "embedded";
  filePath?: string;
}

/** Contrat fonctionnel de CompiledPipelineNode dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface CompiledPipelineNode {
  id: string;
  kind: "agent" | "pause";
  agent?: string;
  prompt?: string;
  /** Instructions invariantes résolues, conservées dans ce champ de compatibilité. */
  promptFile?: string;
  skills: readonly string[];
  needs: readonly string[];
  inputs: readonly PipelineNodeInputDefinition[];
  output?: PipelineNodeOutputDefinition;
  interaction?: PipelineInteractionDefinition;
  retry: PipelineRetryDefinition;
  pause?: PipelinePauseType;
  pauseContent?: string;
  pauseFormat?: PipelinePauseFormat;
  handoff?: PipelineWorkspaceHandoffDefinition;
  workspaceGuard?: "documentation-only";
  policy: NormalizedPipelinePolicy;
}

/** Contrat fonctionnel de CompiledPipelineProgram dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface CompiledPipelineProgram {
  version: 3;
  id: string;
  title: string;
  promotion: NormalizedPromotionPolicy;
  nodes: readonly CompiledPipelineNode[];
  nodesById: ReadonlyMap<string, CompiledPipelineNode>;
  dependentsById: ReadonlyMap<string, readonly string[]>;
  rootNodeIds: readonly string[];
  terminalNodeIds: readonly string[];
}

/** Contrat fonctionnel de PipelineCompileResult dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineCompileResult {
  program?: CompiledPipelineProgram;
  errors: string[];
}

/** Contrat fonctionnel de PipelineRuntimeSnapshot dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineRuntimeSnapshot {
  runId: string;
  pipelineId: string;
  status: "running" | "paused" | "completed" | "failed" | "cancelled";
  inputVariables?: Record<string, unknown>;
  nodeStates: Record<string, PipelineRuntimeNodeSnapshot>;
  artifacts: Record<string, PipelineArtifact>;
  pendingPause?: PipelinePauseSnapshot;
  activeInterview?: PipelineInterviewSnapshot;
  nodeInterviewHistories?: Record<string, PipelineInterviewSnapshot>;
  finalArtifact?: PipelineArtifact;
  diagnostics: PipelineRuntimeDiagnostic[];
  /** Nombre maximal de nœuds agent actifs simultanément dans ce run. */
  maxConcurrency?: number;
  /** État durable de l'adaptateur requis pour reprendre les effets isolés sur le workspace. */
  sandboxRuns?: Record<string, PipelineSandboxRunSnapshot>;
  /** Plan dynamique figé et preuve durable de son éventuelle expansion. */
  executionPlan?: ExecutionPlanSnapshot;
  createdAt: string;
  updatedAt: string;
}

/** Type métier PipelineSandboxIntegrationState utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type PipelineSandboxIntegrationState =
  | "sandbox_created"
  | "checkpointed"
  | "integrating"
  | "integration_conflict"
  | "resume_divergence"
  | "integrated";

/** Contrat fonctionnel de PipelineSandboxCheckpointSnapshot dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineSandboxCheckpointSnapshot {
  status: "checkpointed" | "no_changes";
  commit: string;
  remote: string;
  ref: string;
  preview: {
    baseCommit: string;
    checkpointCommit: string;
    fileCount: number;
    files: string[];
    diff: string;
  };
}

/** Contrat fonctionnel de PipelineSandboxRunSnapshot dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineSandboxRunSnapshot {
  sandboxName: string;
  sandboxId?: string;
  runId: string;
  nodeId: string;
  attempt: number;
  baseCommit: string;
  integrationState: PipelineSandboxIntegrationState;
  resourceState: "active" | "retained" | "removed";
  checkpoint?: PipelineSandboxCheckpointSnapshot;
  output?: string;
  diagnosticsPath?: string;
  integrationDiagnostic?: {
    files: string[];
  };
  resumeDiagnostic?: string;
}

/** Contrat fonctionnel de PipelineRuntimeNodeSnapshot dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineRuntimeNodeSnapshot {
  status: "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";
  attempts: number;
  startedAt?: string;
  completedAt?: string;
}

/** Contrat fonctionnel de PipelinePauseSnapshot dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelinePauseSnapshot {
  id: string;
  nodeId: string;
  type: PipelinePauseType;
  content: string;
  recommendation?: string;
  format: PipelinePauseFormat;
  handoff?: PipelineWorkspaceHandoffDefinition;
  workspaceGuard?: "documentation-only";
  integrationConflict?: PipelineIntegrationConflict;
  sandboxResumeDivergence?: PipelineSandboxResumeDivergence;
}

/** Type métier PipelineInterviewState utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type PipelineInterviewState = "question";

/** Contrat fonctionnel de PipelineInterviewTurn dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineInterviewTurn {
  role: "agent" | "user";
  content: string;
}

/** Contrat fonctionnel de PipelineInterviewSnapshot dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineInterviewSnapshot {
  nodeId: string;
  protocol: string;
  originalPrompt?: string;
  state: PipelineInterviewState;
  completionRequested: boolean;
  turns: PipelineInterviewTurn[];
  structuredOutputs?: PipelineInterviewStructuredOutput[];
  repairAttemptsUsed: number;
  finalOutputRequestsUsed?: number;
}

/** Constante PIPELINE_NODE_ACP_HISTORY_ARTIFACT_NAME qui fixe un contrat partagé du pipeline. */
export const PIPELINE_NODE_ACP_HISTORY_ARTIFACT_NAME = "acpNodeHistory";
/** Constante PIPELINE_NODE_ACP_HISTORY_ARTIFACT_TYPE qui fixe un contrat partagé du pipeline. */
export const PIPELINE_NODE_ACP_HISTORY_ARTIFACT_TYPE = "acp.node-history/v1";

/** Contrat fonctionnel de PipelineInterviewStructuredOutput dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineInterviewStructuredOutput {
  state: "ready";
  content: string;
}

/** Contrat fonctionnel de PipelineRuntimeDiagnostic dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineRuntimeDiagnostic {
  nodeId?: string;
  attempt?: number;
  code: string;
  message: string;
}

/** Type métier PipelineRuntimeResult utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type PipelineRuntimeResult =
  | { status: "completed"; runId: string; artifact?: PipelineArtifact; snapshot: PipelineRuntimeSnapshot }
  | { status: "paused"; runId: string; pause: PipelinePauseSnapshot; snapshot: PipelineRuntimeSnapshot }
  | { status: "failed"; runId: string; error: PipelineRuntimeDiagnostic; snapshot: PipelineRuntimeSnapshot }
  | {
      status: "cancelled";
      runId: string;
      snapshot: PipelineRuntimeSnapshot;
      promotion?: "rejected" | "cancelled";
    };

/** Contrat fonctionnel de PipelineResumeDecision dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineResumeDecision {
  pauseId: string;
  kind: "approve" | "answer" | "complete-interview" | "reject";
  value?: unknown;
}

/** Contrat fonctionnel de PipelineNodeExecutionInput dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineNodeExecutionInput {
  runId: string;
  attempt?: number;
  node: CompiledPipelineNode;
  prompt: string;
  inputs: Record<string, PipelineArtifact>;
  signal: AbortSignal;
  onSandboxRunState?: (state: PipelineSandboxRunSnapshot) => void | Promise<void>;
  resumeSandboxRun?: PipelineSandboxRunSnapshot;
  /** Dernier Agent Checkpoint conservé pour chaque dépendance directe satisfaite. */
  dependencyCheckpoints?: PipelineDependencyCheckpoint[];
}

/** Contrat fonctionnel de PipelineDependencyCheckpoint dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineDependencyCheckpoint {
  runId: string;
  nodeId: string;
  attempt: number;
  sandboxName: string;
  baseCommit: string;
  checkpoint: PipelineSandboxCheckpointSnapshot;
}

/** Contrat fonctionnel de AgentNodeSessionTurnInput dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface AgentNodeSessionTurnInput extends PipelineNodeExecutionInput {
  replay?: boolean;
}

/** Contrat fonctionnel de AgentNodeSessionActivity dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface AgentNodeSessionActivity {
  kind: "message" | "thought" | "status";
  content: string;
}

/** Contrat fonctionnel de PipelineNodeExecutionSuccess dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineNodeExecutionSuccess {
  artifact: Omit<PipelineArtifact, "producerNodeId">;
}

/** Contrat fonctionnel de PipelineNodeExecutionFailure dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineNodeExecutionFailure {
  code: string;
  message: string;
  retryable?: boolean;
}

/** Type métier PipelineNodeExecutionResult utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type PipelineNodeExecutionResult =
  | PipelineNodeExecutionSuccess
  | PipelineNodeExecutionFailure;

/** Contrat fonctionnel de AgentNodeSession dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface AgentNodeSession {
  readonly runId: string;
  readonly nodeId: string;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  send(input: AgentNodeSessionTurnInput): Promise<PipelineNodeExecutionResult>;
  onActivity?(handler: (activity: AgentNodeSessionActivity) => void): () => void;
/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  cancel(): Promise<void>;
/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  close(): Promise<void>;
}

/** Contrat fonctionnel de AgentNodeSessionFactoryInput dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface AgentNodeSessionFactoryInput {
  runId: string;
  node: CompiledPipelineNode;
  signal: AbortSignal;
}

/** Type métier AgentNodeSessionFactory utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type AgentNodeSessionFactory = (
  input: AgentNodeSessionFactoryInput,
) => Promise<AgentNodeSession>;

/** Contrat fonctionnel de PipelineRuntimeAdapter dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineRuntimeAdapter {
  createSession: AgentNodeSessionFactory;
  execute?(input: PipelineNodeExecutionInput): Promise<PipelineNodeExecutionResult>;
}
