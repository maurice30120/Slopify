import type { NormalizedPipelinePolicy, NormalizedPromotionPolicy } from "./PipelinePolicy";
import type { PipelineChangeSetFinalizationInput, PipelineChangeSetFinalizationResult, PipelineChangeSetPreparationResult } from "./PipelineAgentRunner";
import type { PipelineIntegrationConflict, PipelineSandboxResumeDivergence } from "./PipelineAgentRunner";
import type { ExecutionPlanSnapshot } from "./ExecutionPlan";

export type PipelineArtifactFormat = "text" | "markdown" | "json";

export type PipelinePauseType = "approval" | "question" | "promotion";

export type PipelinePauseFormat = "text" | "markdown" | "json" | "proposed-plan";

export interface PipelineArtifact<T = unknown> {
  name: string;
  type: string;
  format: PipelineArtifactFormat;
  value: T;
  producerNodeId: string;
}

export interface PipelineNodeInputDefinition {
  name: string;
  from: string;
  type?: string;
  format?: PipelineArtifactFormat;
}

export interface PipelineNodeOutputDefinition {
  name: string;
  type: string;
  format: PipelineArtifactFormat;
}

export interface PipelineRetryDefinition {
  maxAttempts: number;
  backoffMs?: number;
}

export interface PipelineInteractionDefinition {
  protocol: string;
  repairAttempts: number;
}

export interface PipelinePolicyReference {
  profile?: string;
  filesystem?: "read-only" | "workspace-write";
  terminal?: "none" | "read-only" | "workspace-write";
  network?: "disabled" | "enabled";
  promotion?: "discard" | "ask" | "auto-apply" | "auto-reject";
}

export interface PipelineWorkspaceHandoffDefinition {
  kind: "workspace-files";
  minimumReferences?: number;
  layout?: "delivery";
}

export interface PipelineAgentNodeDefinition {
  id: string;
  type?: "agent";
  agent: string;
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

export type PipelineNodeDefinition =
  | PipelineAgentNodeDefinition
  | PipelinePauseNodeDefinition;

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

export interface PipelineCompileResult {
  program?: CompiledPipelineProgram;
  errors: string[];
}

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
  /** Maximum number of agent nodes that may be active in this run. */
  maxConcurrency?: number;
  /** Durable adapter state required to resume isolated workspace effects. */
  sandboxRuns?: Record<string, PipelineSandboxRunSnapshot>;
  /** Frozen dynamic plan and durable proof of whether it has already expanded. */
  executionPlan?: ExecutionPlanSnapshot;
  /** Unique provisional result reviewed before it becomes eligible for Promotion. */
  pipelineChangeSet?: PipelineChangeSetPreparationResult;
  createdAt: string;
  updatedAt: string;
}

export type PipelineSandboxIntegrationState =
  | "sandbox_created"
  | "checkpointed"
  | "integrating"
  | "integration_conflict"
  | "resume_divergence"
  | "integrated";

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

export interface PipelineRuntimeNodeSnapshot {
  status: "pending" | "running" | "paused" | "completed" | "failed" | "blocked" | "cancelled";
  attempts: number;
  attemptResults?: PipelineNodeAttemptSnapshot[];
  startedAt?: string;
  completedAt?: string;
}

export interface PipelineNodeAttemptSnapshot {
  attempt: number;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  diagnostic?: PipelineRuntimeDiagnostic;
}

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

export type PipelineInterviewState = "question";

export interface PipelineInterviewTurn {
  role: "agent" | "user";
  content: string;
}

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

export const PIPELINE_NODE_ACP_HISTORY_ARTIFACT_NAME = "acpNodeHistory";
export const PIPELINE_NODE_ACP_HISTORY_ARTIFACT_TYPE = "acp.node-history/v1";

export interface PipelineInterviewStructuredOutput {
  state: "ready";
  content: string;
}

export interface PipelineRuntimeDiagnostic {
  nodeId?: string;
  attempt?: number;
  code: string;
  message: string;
}

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

export interface PipelineResumeDecision {
  pauseId: string;
  kind: "approve" | "answer" | "complete-interview" | "reject";
  value?: unknown;
}

export interface PipelineNodeExecutionInput {
  runId: string;
  attempt?: number;
  node: CompiledPipelineNode;
  prompt: string;
  inputs: Record<string, PipelineArtifact>;
  signal: AbortSignal;
  onSandboxRunState?: (state: PipelineSandboxRunSnapshot) => void | Promise<void>;
  resumeSandboxRun?: PipelineSandboxRunSnapshot;
  /** Latest retained Agent Checkpoint for each satisfied direct dependency. */
  dependencyCheckpoints?: PipelineDependencyCheckpoint[];
}

export interface PipelineDependencyCheckpoint {
  runId: string;
  nodeId: string;
  attempt: number;
  sandboxName: string;
  baseCommit: string;
  checkpoint: PipelineSandboxCheckpointSnapshot;
}

export interface AgentNodeSessionTurnInput extends PipelineNodeExecutionInput {
  replay?: boolean;
}

export interface AgentNodeSessionActivity {
  kind: "message" | "thought" | "status";
  content: string;
}

export interface PipelineNodeExecutionSuccess {
  artifact: Omit<PipelineArtifact, "producerNodeId">;
}

export interface PipelineNodeExecutionFailure {
  code: string;
  message: string;
  retryable?: boolean;
}

export type PipelineNodeExecutionResult =
  | PipelineNodeExecutionSuccess
  | PipelineNodeExecutionFailure;

export interface AgentNodeSession {
  readonly runId: string;
  readonly nodeId: string;
  send(input: AgentNodeSessionTurnInput): Promise<PipelineNodeExecutionResult>;
  onActivity?(handler: (activity: AgentNodeSessionActivity) => void): () => void;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface AgentNodeSessionFactoryInput {
  runId: string;
  node: CompiledPipelineNode;
  signal: AbortSignal;
}

export type AgentNodeSessionFactory = (
  input: AgentNodeSessionFactoryInput,
) => Promise<AgentNodeSession>;

export interface PipelineRuntimeAdapter {
  createSession: AgentNodeSessionFactory;
  execute?(input: PipelineNodeExecutionInput): Promise<PipelineNodeExecutionResult>;
  preparePipelineChangeSet?(
    input: PipelineChangeSetFinalizationInput,
  ): Promise<PipelineChangeSetPreparationResult | undefined>;
  finalizePipelineChangeSet?(
    input: PipelineChangeSetFinalizationInput,
  ): Promise<PipelineChangeSetFinalizationResult | undefined>;
  invalidatePipelineChangeSet?(input: PipelineChangeSetFinalizationInput): Promise<void>;
}
