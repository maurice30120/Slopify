import { appendCompiledPipelineNodes, parseArtifactProducer } from "./PipelineV3Compiler";
import {
  READ_ONLY_PIPELINE_POLICY,
  WORKSPACE_WRITE_PIPELINE_POLICY,
  canMutateWorkspace,
  validateAdapterSupportsPolicy,
} from "./PipelinePolicy";
import { getPipelineInterviewProtocol } from "./PipelineInterviewProtocol";
import {
  compileExecutionPlan,
  FINAL_REVIEW_NODE_ID,
  markExecutionPlanExpanded,
  validateExecutionPlan,
  validateExecutionPlanSnapshot,
  type ExecutionPlan,
} from "./ExecutionPlan";
import {
  PIPELINE_NODE_ACP_HISTORY_ARTIFACT_NAME,
  PIPELINE_NODE_ACP_HISTORY_ARTIFACT_TYPE,
} from "./PipelineV3Types";
import type { PipelineAdapterPolicyCapabilities } from "./PipelinePolicy";
import type {
  AgentNodeSessionActivity,
  CompiledPipelineNode,
  CompiledPipelineProgram,
  PipelineArtifact,
  PipelineNodeExecutionFailure,
  PipelineNodeExecutionResult,
  PipelinePauseSnapshot,
  PipelineResumeDecision,
  PipelineRuntimeAdapter,
  PipelineRuntimeDiagnostic,
  PipelineRuntimeResult,
  PipelineRuntimeSnapshot,
  AgentNodeSession,
} from "./PipelineV3Types";

export interface PipelineRuntimeOptions {
  runIdFactory?: () => string;
  now?: () => Date;
  store?: PipelineRunStore;
  programs?: CompiledPipelineProgram[];
  onEvent?: (event: PipelineRuntimeEvent) => void | Promise<void>;
  adapterName?: string;
  adapterCapabilities?: PipelineAdapterPolicyCapabilities;
  resolveNodeSkills?: (node: CompiledPipelineNode) => string[] | Promise<string[]>;
}

export interface PipelineRuntimeEvent {
  runId: string;
  type:
    | "run_started"
    | "node_started"
    | "node_completed"
    | "node_failed"
    | "node_replayed"
    | "agent_activity"
    | "paused"
    | "resumed"
    | "completed"
    | "failed"
    | "cancelled";
  nodeId?: string;
  message?: string;
  activity?: AgentNodeSessionActivity;
  at: string;
}

export interface PipelineRuntimeStartOptions {
  inputs?: Record<string, unknown>;
  executionPlan?: ExecutionPlan;
  maxConcurrency?: number;
}

export interface PipelineRunStore {
  create(snapshot: PipelineRuntimeSnapshot): Promise<void>;
  load(runId: string): Promise<PipelineRuntimeSnapshot | null>;
  save(snapshot: PipelineRuntimeSnapshot): Promise<void>;
  appendEvent(runId: string, event: PipelineRuntimeEvent): Promise<void>;
  listResumable(): Promise<PipelineRuntimeSnapshot[]>;
}

interface ActiveRun {
  program: CompiledPipelineProgram;
  snapshot: PipelineRuntimeSnapshot;
  controller: AbortController;
  sessions: Map<string, AgentNodeSession>;
  activityUnsubscribers: Map<AgentNodeSession, () => void>;
  closedSessions: WeakSet<AgentNodeSession>;
  nodeTasks: Map<string, Promise<NodeTaskResult>>;
  explicitRetryNodes: Set<string>;
  terminalFailure?: PipelineRuntimeDiagnostic;
}

type NodeTaskResult =
  | { nodeId: string; result: PipelineRuntimeDiagnostic | { ok: true } | { paused: PipelineRuntimeResult } }
  | { nodeId: string; thrown: unknown };

/**
 * Orchestre le DAG sans connaître le runtime concret ni effectuer de Promotion.
 * Chaque transition durable est persistée avant l'événement correspondant afin
 * qu'une reprise ne reconstruise jamais un état plus ancien que celui observé.
 * Les sessions restent strictement attachées à un couple run/nœud.
 *
 * Voir `docs/adr/0003-keep-acp-as-the-sandbox-runtime-boundary.md`.
 */
export class PipelineRuntime {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly programsById = new Map<string, CompiledPipelineProgram>();
  private readonly now: () => Date;
  private readonly runIdFactory: () => string;
  private readonly store?: PipelineRunStore;
  private readonly onEvent?: (event: PipelineRuntimeEvent) => void | Promise<void>;
  private readonly adapterName: string;
  private readonly adapterCapabilities?: PipelineAdapterPolicyCapabilities;
  private readonly resolveNodeSkills?: (node: CompiledPipelineNode) => string[] | Promise<string[]>;

  constructor(
    private readonly adapter: PipelineRuntimeAdapter,
    options: PipelineRuntimeOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.runIdFactory = options.runIdFactory ?? (() => `run-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    this.store = options.store;
    this.onEvent = options.onEvent;
    this.adapterName = options.adapterName ?? "pipeline";
    this.adapterCapabilities = options.adapterCapabilities;
    this.resolveNodeSkills = options.resolveNodeSkills;
    for (const program of options.programs ?? []) {
      this.programsById.set(program.id, program);
    }
  }

  async start(
    program: CompiledPipelineProgram,
    options: PipelineRuntimeStartOptions = {},
  ): Promise<PipelineRuntimeResult> {
    if (options.maxConcurrency !== undefined
      && (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1)) {
      throw new Error("maxConcurrency must be an integer greater than or equal to 1.");
    }
    this.programsById.set(program.id, program);
    const runId = this.runIdFactory();
    const at = this.isoNow();
    const executionPlan = options.executionPlan ? validateExecutionPlan(options.executionPlan) : undefined;
    if (executionPlan && (!executionPlan.plan || executionPlan.errors.length > 0)) {
      throw new Error(`Invalid Execution Plan: ${executionPlan.errors.join(" ")}`);
    }
    const snapshot: PipelineRuntimeSnapshot = {
      runId,
      pipelineId: program.id,
      status: "running",
      inputVariables: cloneInputVariables(options.inputs),
      nodeStates: Object.fromEntries(program.nodes.map(node => [node.id, { status: "pending", attempts: 0 }])),
      artifacts: {},
      diagnostics: [],
      ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
      ...(executionPlan?.plan ? {
        executionPlan: {
          plan: executionPlan.plan,
          expansion: { status: "pending", expandedNodeIds: [] },
        },
      } : {}),
      createdAt: at,
      updatedAt: at,
    };
    const active: ActiveRun = {
      program,
      snapshot,
      controller: new AbortController(),
      sessions: new Map(),
      activityUnsubscribers: new Map(),
      closedSessions: new WeakSet(),
      nodeTasks: new Map(),
      explicitRetryNodes: new Set(),
    };
    this.runs.set(runId, active);
    await this.store?.create(cloneSnapshot(snapshot));
    await this.emitRuntimeEvent({ runId, type: "run_started", at });
    return this.advance(active);
  }

  async resume(runId: string, decision: PipelineResumeDecision): Promise<PipelineRuntimeResult> {
    const active = await this.requireActiveRun(runId);
    const pause = active.snapshot.pendingPause;
    if (!pause || pause.id !== decision.pauseId) {
      const diagnostic = {
        code: "invalid_resume",
        message: `Pause "${decision.pauseId}" is not current for run "${runId}".`,
      };
      return { status: "failed", runId, error: diagnostic, snapshot: cloneSnapshot(active.snapshot) };
    }
    if (decision.kind === "reject") {
      await this.cancelActiveSessions(active);
      active.snapshot.status = "cancelled";
      active.snapshot.pendingPause = undefined;
      active.snapshot.updatedAt = this.isoNow();
      await this.persist(active.snapshot);
      await this.emitRuntimeEvent({ runId, type: "cancelled", nodeId: pause.nodeId, message: "Pause rejected.", at: active.snapshot.updatedAt });
      this.runs.delete(runId);
      return { status: "cancelled", runId, snapshot: cloneSnapshot(active.snapshot) };
    }

    const node = active.program.nodesById.get(pause.nodeId);
    if (!node) {
      return this.fail(active, { code: "missing_pause_node", message: `Pause node "${pause.nodeId}" is missing.` });
    }
    if (node.kind === "agent" && node.interaction) {
      if (!active.snapshot.activeInterview || active.snapshot.activeInterview.nodeId !== node.id) {
        return this.fail(active, { code: "missing_active_interview", message: `Interview node "${node.id}" is not active.` });
      }
      if (decision.kind === "answer") {
        const value = typeof decision.value === "string" ? decision.value : stringifyTemplateValue(decision.value);
        active.snapshot.activeInterview.turns.push({ role: "user", content: value });
      } else if (decision.kind === "complete-interview") {
        active.snapshot.activeInterview.completionRequested = true;
        active.snapshot.activeInterview.finalOutputRequestsUsed ??= 0;
      } else {
        return this.fail(active, { code: "invalid_resume", message: `Decision "${decision.kind}" cannot resume an interview question.` });
      }
      this.recordInterviewHistory(active, active.snapshot.activeInterview);
      active.snapshot.pendingPause = undefined;
      active.snapshot.status = "running";
      active.snapshot.nodeStates[node.id] = {
        ...active.snapshot.nodeStates[node.id],
        status: "running",
      };
      active.snapshot.updatedAt = this.isoNow();
      await this.persist(active.snapshot);
      await this.emitRuntimeEvent({ runId, type: "resumed", nodeId: pause.nodeId, at: active.snapshot.updatedAt });
      return this.continueInterview(active, node);
    }
    if (decision.kind === "complete-interview") {
      return this.fail(active, { code: "invalid_resume", message: "complete-interview can only resume an interview question." });
    }
    if (node.output) {
      const value = decision.value ?? "";
      const artifact = {
        ...node.output,
        value,
        producerNodeId: node.id,
      };
      const planError = this.acceptArtifact(active, artifact);
      if (planError) return this.fail(active, planError);
    }
    active.snapshot.nodeStates[pause.nodeId] = {
      ...active.snapshot.nodeStates[pause.nodeId],
      status: "completed",
      completedAt: this.isoNow(),
    };
    active.snapshot.pendingPause = undefined;
    active.snapshot.status = "running";
    active.snapshot.updatedAt = this.isoNow();
    await this.persist(active.snapshot);
    await this.emitRuntimeEvent({ runId, type: "resumed", nodeId: pause.nodeId, at: active.snapshot.updatedAt });
    return this.advance(active);
  }

  async retryNode(
    runId: string,
    nodeId: string,
    pauseId: string,
  ): Promise<PipelineRuntimeResult> {
    const active = await this.requireActiveRun(runId);
    const pause = active.snapshot.pendingPause;
    if (!pause || pause.id !== pauseId || pause.nodeId !== nodeId) {
      const diagnostic = {
        code: "invalid_resume",
        message: `Pause "${pauseId}" is not current for run "${runId}".`,
      };
      return { status: "failed", runId, error: diagnostic, snapshot: cloneSnapshot(active.snapshot) };
    }
    const node = active.program.nodesById.get(nodeId);
    if (!node || node.kind !== "agent") {
      const diagnostic = {
        nodeId,
        code: "invalid_retry_node",
        message: `Node "${nodeId}" is not an agent node in run "${runId}".`,
      };
      return { status: "failed", runId, error: diagnostic, snapshot: cloneSnapshot(active.snapshot) };
    }
    const state = active.snapshot.nodeStates[nodeId];
    if (!state || state.status !== "completed") {
      const diagnostic = {
        nodeId,
        code: "invalid_retry_node",
        message: `Node "${nodeId}" is not completed in run "${runId}".`,
      };
      return { status: "failed", runId, error: diagnostic, snapshot: cloneSnapshot(active.snapshot) };
    }

    for (const [key, artifact] of Object.entries(active.snapshot.artifacts)) {
      if (artifact.producerNodeId === nodeId) {
        delete active.snapshot.artifacts[key];
      }
    }
    if (active.snapshot.finalArtifact?.producerNodeId === nodeId) {
      active.snapshot.finalArtifact = undefined;
    }
    active.snapshot.nodeStates[nodeId] = {
      status: "pending",
      attempts: state.attempts,
      attemptResults: state.attemptResults,
    };
    active.snapshot.pendingPause = undefined;
    active.snapshot.status = "running";
    active.snapshot.updatedAt = this.isoNow();
    active.explicitRetryNodes.add(nodeId);
    await this.persist(active.snapshot);
    await this.emitRuntimeEvent({ runId, type: "resumed", nodeId, at: active.snapshot.updatedAt });
    return this.advance(active);
  }

  async cancel(runId: string): Promise<PipelineRuntimeResult> {
    const active = await this.requireActiveRun(runId);
    active.controller.abort();
    await this.cancelActiveSessions(active);
    for (const [nodeId, state] of Object.entries(active.snapshot.nodeStates)) {
      if (state.status === "pending" || state.status === "running" || state.status === "paused") {
        active.snapshot.nodeStates[nodeId] = { ...state, status: "cancelled" };
      }
    }
    active.snapshot.status = "cancelled";
    active.snapshot.pendingPause = undefined;
    active.snapshot.updatedAt = this.isoNow();
    await this.persist(active.snapshot);
    await this.emitRuntimeEvent({ runId, type: "cancelled", at: active.snapshot.updatedAt });
    this.runs.delete(runId);
    return { status: "cancelled", runId, snapshot: cloneSnapshot(active.snapshot) };
  }

  async recover(runId: string): Promise<PipelineRuntimeResult> {
    const active = await this.requireActiveRun(runId);
    if (active.snapshot.pendingPause) {
      return {
        status: "paused",
        runId,
        pause: active.snapshot.pendingPause,
        snapshot: cloneSnapshot(active.snapshot),
      };
    }
    if (active.snapshot.status !== "running") {
      throw new Error(`Pipeline run "${runId}" is not recoverable from status "${active.snapshot.status}".`);
    }
    for (const [nodeId, state] of Object.entries(active.snapshot.nodeStates)) {
      if (state.status === "running") {
        active.snapshot.nodeStates[nodeId] = {
          ...state,
          status: "pending",
          attempts: Math.max(0, state.attempts - 1),
        };
      }
    }
    active.snapshot.updatedAt = this.isoNow();
    await this.persist(active.snapshot);
    return this.advance(active);
  }

  protected async suspendRecoveredRun(
    runId: string,
    pause: PipelinePauseSnapshot,
    update?: (snapshot: PipelineRuntimeSnapshot) => void,
  ): Promise<PipelineRuntimeResult> {
    const active = await this.requireActiveRun(runId);
    active.snapshot.status = "paused";
    active.snapshot.pendingPause = pause;
    update?.(active.snapshot);
    active.snapshot.updatedAt = this.isoNow();
    await this.persist(active.snapshot);
    await this.emitRuntimeEvent({ runId, type: "paused", nodeId: pause.nodeId, at: active.snapshot.updatedAt });
    return { status: "paused", runId, pause, snapshot: cloneSnapshot(active.snapshot) };
  }

  protected async retryRecoveredRun(runId: string): Promise<PipelineRuntimeResult> {
    const active = await this.requireActiveRun(runId);
    active.controller = new AbortController();
    active.snapshot.status = "running";
    active.snapshot.pendingPause = undefined;
    for (const [nodeId, state] of Object.entries(active.snapshot.nodeStates)) {
      if (state.status === "running") {
        active.snapshot.nodeStates[nodeId] = {
          ...state,
          status: "pending",
          attempts: Math.max(0, state.attempts - 1),
        };
      }
    }
    active.snapshot.updatedAt = this.isoNow();
    await this.persist(active.snapshot);
    return this.advance(active);
  }

  async inspect(runId: string): Promise<PipelineRuntimeSnapshot | null> {
    const active = this.runs.get(runId);
    if (active) {
      return cloneSnapshot(active.snapshot);
    }
    return this.store?.load(runId).then(snapshot => snapshot && cloneSnapshot(snapshot)) ?? null;
  }

  private async advance(active: ActiveRun): Promise<PipelineRuntimeResult> {
    while (active.snapshot.status === "running") {
      const expansionError = active.terminalFailure ? undefined : await this.expandExecutionPlan(active);
      if (expansionError) return this.fail(active, expansionError);
      const ready = active.terminalFailure ? [] : this.readyNodes(active);
      if (ready.length === 0 && active.nodeTasks.size === 0) {
        if (active.terminalFailure) {
          return this.fail(active, active.terminalFailure);
        }
        if (this.isComplete(active)) {
          return this.complete(active);
        }
        const diagnostic = { code: "deadlock", message: "No runnable nodes remain before completion." };
        return this.fail(active, diagnostic);
      }

      const pause = ready.find(node => node.kind === "pause");
      if (pause) {
        return this.pause(active, pause);
      }

      const firstInterview = ready.find(node => node.kind === "agent" && node.interaction);
      const batch = ready.filter(node =>
        node.kind === "agent"
        && (!node.interaction || node.id === firstInterview?.id)
      );
      const available = (active.snapshot.maxConcurrency ?? Number.POSITIVE_INFINITY) - active.nodeTasks.size;
      for (const node of batch.slice(0, Math.max(0, available))) {
        this.startNodeTask(active, node);
      }
      if (active.nodeTasks.size === 0) {
        continue;
      }

      const completed = await Promise.race(active.nodeTasks.values());
      active.nodeTasks.delete(completed.nodeId);
      if ("thrown" in completed) {
        active.controller.abort();
        await this.cancelActiveSessions(active);
        const peers = [...active.nodeTasks.values()];
        active.nodeTasks.clear();
        await Promise.allSettled(peers);
        throw completed.thrown;
      }
      const result = completed.result;
      const failure = "code" in result ? result : undefined;
      if (failure) {
        active.terminalFailure ??= failure;
        this.blockPendingNodes(active);
        active.snapshot.status = "running";
        active.snapshot.updatedAt = this.isoNow();
        await this.persist(active.snapshot);
        continue;
      }
      if ("paused" in result) {
        if (active.terminalFailure) {
          this.blockPausedNode(active);
          active.snapshot.updatedAt = this.isoNow();
          await this.persist(active.snapshot);
          continue;
        }
        return result.paused;
      }
      const pendingPause = active.snapshot.pendingPause;
      if (pendingPause) {
        return {
          status: "paused",
          runId: active.snapshot.runId,
          pause: pendingPause,
          snapshot: cloneSnapshot(active.snapshot),
        };
      }
    }
    const pendingPause = active.snapshot.pendingPause;
    if (pendingPause) {
      return {
        status: "paused",
        runId: active.snapshot.runId,
        pause: pendingPause,
        snapshot: cloneSnapshot(active.snapshot),
      };
    }
    return { status: "cancelled", runId: active.snapshot.runId, snapshot: cloneSnapshot(active.snapshot) };
  }

  private startNodeTask(active: ActiveRun, node: CompiledPipelineNode): void {
    if (active.nodeTasks.has(node.id)) {
      return;
    }
    const task = this.executeNode(active, node)
      .then(result => ({ nodeId: node.id, result }))
      .catch((thrown: unknown) => ({ nodeId: node.id, thrown }));
    active.nodeTasks.set(node.id, task);
  }

  private readyNodes(active: ActiveRun): CompiledPipelineNode[] {
    return active.program.nodes
      .filter(node => active.snapshot.nodeStates[node.id]?.status === "pending")
      .filter(node => node.needs.every(dependency => active.snapshot.nodeStates[dependency]?.status === "completed"));
  }

  private async expandExecutionPlan(active: ActiveRun): Promise<PipelineRuntimeDiagnostic | undefined> {
    const snapshot = active.snapshot.executionPlan;
    if (!snapshot) return undefined;
    const dynamicNodes = executionPlanNodes(snapshot.plan);
    if (snapshot.expansion.status === "expanded") {
      if (!dynamicNodes.every(node => active.program.nodesById.has(node.id))) {
        active.program = appendCompiledPipelineNodes(active.program, dynamicNodes);
      }
      for (const node of dynamicNodes) {
        active.snapshot.nodeStates[node.id] ??= { status: "pending", attempts: 0 };
      }
      return undefined;
    }
    const collisions = dynamicNodes.filter(node => active.program.nodesById.has(node.id));
    if (collisions.length > 0) {
      return {
        code: "execution_plan_node_collision",
        message: `Execution Plan node identities collide with pipeline nodes: ${collisions.map(node => node.id).sort().join(", ")}.`,
      };
    }
    active.program = appendCompiledPipelineNodes(active.program, dynamicNodes);
    for (const node of dynamicNodes) {
      active.snapshot.nodeStates[node.id] = { status: "pending", attempts: 0 };
    }
    active.snapshot.executionPlan = markExecutionPlanExpanded(
      snapshot,
      dynamicNodes.map(node => node.id),
      this.isoNow(),
    );
    active.snapshot.updatedAt = this.isoNow();
    await this.persist(active.snapshot);
    return undefined;
  }

  private async executeNode(active: ActiveRun, node: CompiledPipelineNode): Promise<PipelineRuntimeDiagnostic | { ok: true } | { paused: PipelineRuntimeResult }> {
    const state = active.snapshot.nodeStates[node.id];
    const inputs = resolveInputs(node, active.snapshot.artifacts);
    let prompt = renderRuntimeTemplate(node.prompt ?? "", active.snapshot.inputVariables ?? {}, inputs);
    if (node.id === FINAL_REVIEW_NODE_ID && this.adapter.preparePipelineChangeSet) {
      const prepared = active.snapshot.pipelineChangeSet ?? await this.adapter.preparePipelineChangeSet({
        runId: active.snapshot.runId,
        program: active.program,
        snapshot: structuredClone(active.snapshot),
      });
      if (prepared) {
        active.snapshot.pipelineChangeSet = structuredClone(prepared);
        active.snapshot.updatedAt = this.isoNow();
        await this.persist(active.snapshot);
        prompt = `${prompt}\n\nReview this complete provisional Pipeline Change Set, including interactions between all integrated checkpoints:\n${JSON.stringify(prepared, null, 2)}`;
      }
    }
    const skillErrors = this.resolveNodeSkills ? await this.resolveNodeSkills(node) : [];
    if (skillErrors.length > 0) {
      const attempt = state.attempts + 1;
      this.startAttempt(active, node.id, attempt);
      active.snapshot.nodeStates[node.id] = {
        ...active.snapshot.nodeStates[node.id],
        status: "failed",
        completedAt: this.isoNow(),
      };
      this.finishAttempt(active, node.id, attempt, "failed", {
        nodeId: node.id, attempt, code: "skill_resolution_failed", message: skillErrors.join("; "),
      });
      active.snapshot.updatedAt = this.isoNow();
      await this.persist(active.snapshot);
      return {
        nodeId: node.id,
        attempt,
        code: "skill_resolution_failed",
        message: skillErrors.join("; "),
      };
    }
    const unsupportedPolicy = this.adapterCapabilities
      ? validateAdapterSupportsPolicy(this.adapterName, this.adapterCapabilities, node.policy)[0]
      : undefined;
    if (unsupportedPolicy) {
      const attempt = state.attempts + 1;
      this.startAttempt(active, node.id, attempt);
      active.snapshot.nodeStates[node.id] = {
        ...active.snapshot.nodeStates[node.id],
        status: "failed",
        completedAt: this.isoNow(),
      };
      this.finishAttempt(active, node.id, attempt, "failed", {
        nodeId: node.id, attempt, code: unsupportedPolicy.code, message: unsupportedPolicy.message,
      });
      active.snapshot.updatedAt = this.isoNow();
      await this.persist(active.snapshot);
      return {
        nodeId: node.id,
        attempt,
        code: unsupportedPolicy.code,
        message: unsupportedPolicy.message,
      };
    }
    const explicitRetry = active.explicitRetryNodes.delete(node.id);
    const maximumAttempt = explicitRetry ? state.attempts + 1 : node.retry.maxAttempts;
    if (node.interaction) {
      return this.executeInterviewNode(active, node, prompt, inputs, undefined, maximumAttempt);
    }
    for (let attempt = state.attempts + 1; attempt <= maximumAttempt; attempt++) {
      this.startAttempt(active, node.id, attempt);
      active.snapshot.updatedAt = this.isoNow();
      await this.persist(active.snapshot);
      await this.emitRuntimeEvent({ runId: active.snapshot.runId, type: "node_started", nodeId: node.id, at: active.snapshot.updatedAt });

      let session: AgentNodeSession;
      try {
        session = await this.openAttemptSession(active, node);
      } catch (error: unknown) {
        const diagnostic = sessionBoundaryDiagnostic(active, node, attempt, error);
        this.finishAttempt(active, node.id, attempt, "failed", diagnostic);
        active.snapshot.nodeStates[node.id] = {
          ...active.snapshot.nodeStates[node.id], status: "failed", completedAt: this.isoNow(),
        };
        active.snapshot.updatedAt = this.isoNow();
        await this.persist(active.snapshot);
        return diagnostic;
      }
      try {
        const result = await session.send({
          runId: active.snapshot.runId,
          attempt,
          node,
          prompt,
          inputs,
          signal: active.controller.signal,
          onSandboxRunState: state => this.persistSandboxRunState(active, state),
          resumeSandboxRun: this.resumeSandboxRun(active, node.id, attempt),
          dependencyCheckpoints: dependencyCheckpoints(active, node),
        });
        if (active.controller.signal.aborted) {
          return { ok: true };
        }
        if ("artifact" in result) {
          const checkpointError = requiredCheckpointDiagnostic(active, node, attempt);
          if (checkpointError) {
            this.failNodeAttempt(active, node.id, attempt, checkpointError);
            return checkpointError;
          }
          const artifact = assertArtifact(node, result);
          const planError = this.acceptArtifact(active, artifact);
          if (planError) {
            this.failNodeAttempt(active, node.id, attempt, planError);
            return planError;
          }
          active.snapshot.nodeStates[node.id] = {
            ...active.snapshot.nodeStates[node.id],
            status: "completed",
            completedAt: this.isoNow(),
          };
          this.finishAttempt(active, node.id, attempt, "completed");
          active.snapshot.updatedAt = this.isoNow();
          await this.persist(active.snapshot);
          await this.emitRuntimeEvent({ runId: active.snapshot.runId, type: "node_completed", nodeId: node.id, at: active.snapshot.updatedAt });
          return { ok: true };
        }

        active.snapshot.diagnostics.push({ nodeId: node.id, attempt, code: result.code, message: result.message });
        this.finishAttempt(active, node.id, attempt, "failed", {
          nodeId: node.id, attempt, code: result.code, message: result.message,
        });
        if (!result.retryable || attempt >= maximumAttempt) {
          active.snapshot.nodeStates[node.id] = {
            ...active.snapshot.nodeStates[node.id],
            status: "failed",
            completedAt: this.isoNow(),
          };
          active.snapshot.updatedAt = this.isoNow();
          await this.persist(active.snapshot);
          await this.emitRuntimeEvent({ runId: active.snapshot.runId, type: "node_failed", nodeId: node.id, message: result.message, at: active.snapshot.updatedAt });
          return { nodeId: node.id, attempt, code: result.code, message: result.message };
        }
      } finally {
        await this.closeSessionForRun(active, session);
      }
      await sleep(node.retry.backoffMs ?? 0);
    }
    return { nodeId: node.id, code: "retry_exhausted", message: `Node "${node.id}" exhausted retries.` };
  }

  private async continueInterview(active: ActiveRun, node: CompiledPipelineNode): Promise<PipelineRuntimeResult> {
    const state = active.snapshot.nodeStates[node.id];
    const inputs = resolveInputs(node, active.snapshot.artifacts);
    const prompt = renderRuntimeTemplate(node.prompt ?? "", active.snapshot.inputVariables ?? {}, inputs);
    const result = await this.executeInterviewNode(active, node, prompt, inputs, state.attempts);
    if ("paused" in result) {
      return result.paused;
    }
    if ("code" in result) {
      active.controller.abort();
      return this.fail(active, result);
    }
    return this.advance(active);
  }

  private async executeInterviewNode(
    active: ActiveRun,
    node: CompiledPipelineNode,
    originalPrompt: string,
    inputs: Record<string, PipelineArtifact>,
    fixedAttempt?: number,
    maximumAttempt = node.retry.maxAttempts,
  ): Promise<PipelineRuntimeDiagnostic | { ok: true } | { paused: PipelineRuntimeResult }> {
    const protocol = node.interaction ? getPipelineInterviewProtocol(node.interaction.protocol) : undefined;
    if (!protocol || !node.output || !node.interaction) {
      return { nodeId: node.id, code: "invalid_interaction", message: `Node "${node.id}" has an invalid interaction configuration.` };
    }
    const existing = active.snapshot.activeInterview?.nodeId === node.id
      ? active.snapshot.activeInterview
      : undefined;
    if (!existing) {
      active.snapshot.activeInterview = {
        nodeId: node.id,
        protocol: node.interaction.protocol,
        originalPrompt,
        state: "question",
        completionRequested: false,
        turns: [],
        repairAttemptsUsed: 0,
        finalOutputRequestsUsed: 0,
      };
    }
    const interview = active.snapshot.activeInterview!;
    interview.originalPrompt ??= originalPrompt;
    interview.finalOutputRequestsUsed ??= 0;
    interview.repairAttemptsUsed = 0;
    let prompt = protocol.renderReplay({
      originalPrompt: interview.originalPrompt,
      turns: interview.turns,
      completionRequested: interview.completionRequested,
    });
    const firstAttempt = fixedAttempt ?? active.snapshot.nodeStates[node.id].attempts + 1;
    let replayNextAttempt = Boolean(existing) && !active.sessions.has(node.id);

    for (let attempt = firstAttempt; attempt <= maximumAttempt; attempt++) {
      this.startAttempt(active, node.id, attempt);
      active.snapshot.updatedAt = this.isoNow();
      await this.persist(active.snapshot);
      const isReplay = replayNextAttempt;
      replayNextAttempt = false;
      if (isReplay) {
        await this.emitRuntimeEvent({ runId: active.snapshot.runId, type: "node_replayed", nodeId: node.id, message: "Interview replayed from node ACP history.", at: active.snapshot.updatedAt });
      } else if (!existing && attempt === firstAttempt) {
        await this.emitRuntimeEvent({ runId: active.snapshot.runId, type: "node_started", nodeId: node.id, at: active.snapshot.updatedAt });
      }

      for (;;) {
        let session: AgentNodeSession;
        try {
          session = await this.openInterviewSession(active, node);
        } catch (error: unknown) {
          const diagnostic = sessionBoundaryDiagnostic(active, node, attempt, error);
          this.finishAttempt(active, node.id, attempt, "failed", diagnostic);
          active.snapshot.nodeStates[node.id] = {
            ...active.snapshot.nodeStates[node.id], status: "failed", completedAt: this.isoNow(),
          };
          active.snapshot.updatedAt = this.isoNow();
          await this.persist(active.snapshot);
          return diagnostic;
        }
        const result = await session.send({
          runId: active.snapshot.runId,
          attempt,
          node,
          prompt,
          inputs,
          signal: active.controller.signal,
          onSandboxRunState: state => this.persistSandboxRunState(active, state),
          resumeSandboxRun: this.resumeSandboxRun(active, node.id, attempt),
          replay: isReplay,
        });
        if (!("artifact" in result)) {
          active.snapshot.diagnostics.push({ nodeId: node.id, attempt, code: result.code, message: result.message });
          if (!result.retryable || attempt >= maximumAttempt) {
            active.snapshot.nodeStates[node.id] = {
              ...active.snapshot.nodeStates[node.id],
              status: "failed",
              completedAt: this.isoNow(),
            };
            active.snapshot.updatedAt = this.isoNow();
            this.finishAttempt(active, node.id, attempt, "failed", {
              nodeId: node.id, attempt, code: result.code, message: result.message,
            });
            await this.persist(active.snapshot);
            return { nodeId: node.id, attempt, code: result.code, message: result.message };
          }
          // Un historique ACP ne doit être rejoué que si la session distante a
          // été perdue. Une autre erreur retryable relance la tentative sans
          // dupliquer dans l'agent les tours déjà présents dans la session.
          const shouldReplayTransportLoss = isInterviewTransportLoss(result);
          this.finishAttempt(active, node.id, attempt, "failed", {
            nodeId: node.id, attempt, code: result.code, message: result.message,
          });
          await this.closeInterviewSession(active, node.id);
          replayNextAttempt = shouldReplayTransportLoss;
          await sleep(node.retry.backoffMs ?? 0);
          break;
        }

        const text = stringifyTemplateValue(result.artifact.value);
        try {
          const parsed = protocol.parseAgentOutput(text);
          if (parsed.state === "question") {
            if (interview.completionRequested) {
              throw new Error("Expected ready after complete-interview, but the agent returned question.");
            }
            interview.turns.push({ role: "agent", content: parsed.content });
            this.recordInterviewHistory(active, interview);
            return this.pauseInterview(active, node, parsed.question, parsed.recommendedAnswer);
          }

          interview.structuredOutputs = [
            ...(interview.structuredOutputs ?? []),
            { state: "ready", content: stringifyTemplateValue(parsed.content) },
          ];
          const finalResult: PipelineNodeExecutionResult = {
            artifact: {
              name: node.output.name,
              type: node.output.type,
              format: node.output.format,
              value: parsed.artifact,
            },
          };
          const checkpointError = requiredCheckpointDiagnostic(active, node, attempt);
          if (checkpointError) {
            this.failNodeAttempt(active, node.id, attempt, checkpointError);
            return checkpointError;
          }
          const artifact = assertArtifact(node, finalResult);
          const planError = this.acceptArtifact(active, artifact);
          if (planError) {
            this.failNodeAttempt(active, node.id, attempt, planError);
            return planError;
          }
          this.recordInterviewHistory(active, interview);
          active.snapshot.activeInterview = undefined;
          active.snapshot.nodeStates[node.id] = {
            ...active.snapshot.nodeStates[node.id],
            status: "completed",
            completedAt: this.isoNow(),
          };
          this.finishAttempt(active, node.id, attempt, "completed");
          active.snapshot.updatedAt = this.isoNow();
          await this.persist(active.snapshot);
          await this.emitRuntimeEvent({ runId: active.snapshot.runId, type: "node_completed", nodeId: node.id, at: active.snapshot.updatedAt });
          return { ok: true };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          if (interview.completionRequested && interview.finalOutputRequestsUsed < 1) {
            interview.finalOutputRequestsUsed += 1;
            prompt = protocol.renderFinalOutputRequest({ prompt, diagnostic: message });
            active.snapshot.updatedAt = this.isoNow();
            this.recordInterviewHistory(active, interview);
            await this.persist(active.snapshot);
            continue;
          }
          if (interview.completionRequested) {
            active.snapshot.diagnostics.push({
              nodeId: node.id,
              attempt,
              code: "malformed_interview_output",
              message,
            });
            active.snapshot.nodeStates[node.id] = {
              ...active.snapshot.nodeStates[node.id],
              status: "failed",
              completedAt: this.isoNow(),
            };
            this.finishAttempt(active, node.id, attempt, "failed", {
              nodeId: node.id, attempt, code: "malformed_interview_output", message,
            });
            active.snapshot.updatedAt = this.isoNow();
            this.recordInterviewHistory(active, interview);
            await this.persist(active.snapshot);
            return { nodeId: node.id, attempt, code: "malformed_interview_output", message };
          }
          if (interview.repairAttemptsUsed < node.interaction.repairAttempts) {
            interview.repairAttemptsUsed += 1;
            prompt = protocol.renderRepair({ prompt, diagnostic: message });
            active.snapshot.updatedAt = this.isoNow();
            this.recordInterviewHistory(active, interview);
            await this.persist(active.snapshot);
            continue;
          }
          active.snapshot.diagnostics.push({
            nodeId: node.id,
            attempt,
            code: "malformed_interview_output",
            message,
          });
          active.snapshot.nodeStates[node.id] = {
            ...active.snapshot.nodeStates[node.id],
            status: "failed",
            completedAt: this.isoNow(),
          };
          this.finishAttempt(active, node.id, attempt, "failed", {
            nodeId: node.id, attempt, code: "malformed_interview_output", message,
          });
          active.snapshot.updatedAt = this.isoNow();
          await this.persist(active.snapshot);
          return { nodeId: node.id, attempt, code: "malformed_interview_output", message };
        }
      }
    }
    return { nodeId: node.id, code: "retry_exhausted", message: `Node "${node.id}" exhausted retries.` };
  }

  private async pauseInterview(active: ActiveRun, node: CompiledPipelineNode, question: string, recommendation?: string): Promise<{ paused: PipelineRuntimeResult }> {
    const state = active.snapshot.nodeStates[node.id];
    const turn = active.snapshot.activeInterview?.turns.filter(entry => entry.role === "agent").length ?? state.attempts;
    const pause = {
      id: `${active.snapshot.runId}:${node.id}:question:${turn}`,
      nodeId: node.id,
      type: "question" as const,
      content: question,
      ...(recommendation ? { recommendation } : {}),
      format: "markdown" as const,
    };
    active.snapshot.nodeStates[node.id] = {
      ...state,
      status: "paused",
    };
    active.snapshot.pendingPause = pause;
    active.snapshot.status = "paused";
    active.snapshot.updatedAt = this.isoNow();
    await this.persist(active.snapshot);
    await this.emitRuntimeEvent({ runId: active.snapshot.runId, type: "paused", nodeId: node.id, at: active.snapshot.updatedAt });
    return { paused: { status: "paused", runId: active.snapshot.runId, pause, snapshot: cloneSnapshot(active.snapshot) } };
  }

  private async pause(active: ActiveRun, node: CompiledPipelineNode): Promise<PipelineRuntimeResult> {
    const state = active.snapshot.nodeStates[node.id];
    const inputs = resolveInputs(node, active.snapshot.artifacts);
    const pauseId = `${active.snapshot.runId}:${node.id}:${state.attempts + 1}`;
    const pause = {
      id: pauseId,
      nodeId: node.id,
      type: node.pause!,
      content: renderRuntimeTemplate(node.pauseContent!, active.snapshot.inputVariables ?? {}, inputs),
      format: node.pauseFormat ?? "markdown",
      ...(node.handoff ? { handoff: node.handoff } : {}),
      ...(node.workspaceGuard ? { workspaceGuard: node.workspaceGuard } : {}),
    };
    active.snapshot.nodeStates[node.id] = {
      ...state,
      status: "paused",
      attempts: state.attempts + 1,
      startedAt: state.startedAt ?? this.isoNow(),
    };
    active.snapshot.pendingPause = pause;
    active.snapshot.status = "paused";
    active.snapshot.updatedAt = this.isoNow();
    await this.persist(active.snapshot);
    await this.emitRuntimeEvent({ runId: active.snapshot.runId, type: "paused", nodeId: node.id, at: active.snapshot.updatedAt });
    return { status: "paused", runId: active.snapshot.runId, pause, snapshot: cloneSnapshot(active.snapshot) };
  }

  private async complete(active: ActiveRun): Promise<PipelineRuntimeResult> {
    const terminalArtifacts = active.program.terminalNodeIds
      .map(nodeId => active.program.nodesById.get(nodeId))
      .filter((node): node is CompiledPipelineNode => Boolean(node?.output))
      .map(node => active.snapshot.artifacts[artifactKey(node.id, node.output!.name)])
      .filter(Boolean);
    active.snapshot.finalArtifact = terminalArtifacts.at(-1);
    active.snapshot.status = "completed";
    active.snapshot.updatedAt = this.isoNow();
    await this.persist(active.snapshot);
    await this.emitRuntimeEvent({ runId: active.snapshot.runId, type: "completed", at: active.snapshot.updatedAt });
    await this.closeActiveSessions(active);
    this.runs.delete(active.snapshot.runId);
    return {
      status: "completed",
      runId: active.snapshot.runId,
      artifact: active.snapshot.finalArtifact,
      snapshot: cloneSnapshot(active.snapshot),
    };
  }

  private async fail(active: ActiveRun, diagnostic: PipelineRuntimeDiagnostic): Promise<PipelineRuntimeResult> {
    active.snapshot.status = "failed";
    active.snapshot.diagnostics.push(diagnostic);
    for (const [nodeId, state] of Object.entries(active.snapshot.nodeStates)) {
      if (state.status === "pending") {
        active.snapshot.nodeStates[nodeId] = { ...state, status: "blocked" };
      } else if (state.status === "running") {
        active.snapshot.nodeStates[nodeId] = { ...state, status: "cancelled" };
      }
    }
    active.snapshot.updatedAt = this.isoNow();
    await this.persist(active.snapshot);
    await this.emitRuntimeEvent({ runId: active.snapshot.runId, type: "failed", nodeId: diagnostic.nodeId, message: diagnostic.message, at: active.snapshot.updatedAt });
    await this.closeActiveSessions(active);
    this.runs.delete(active.snapshot.runId);
    return { status: "failed", runId: active.snapshot.runId, error: diagnostic, snapshot: cloneSnapshot(active.snapshot) };
  }

  private isComplete(active: ActiveRun): boolean {
    return active.program.nodes.every(node => active.snapshot.nodeStates[node.id]?.status === "completed");
  }

  private blockPendingNodes(active: ActiveRun): void {
    for (const [nodeId, state] of Object.entries(active.snapshot.nodeStates)) {
      if (state.status === "pending") {
        active.snapshot.nodeStates[nodeId] = { ...state, status: "blocked" };
      }
    }
    if (active.snapshot.pendingPause) {
      this.blockPausedNode(active);
    }
  }

  private blockPausedNode(active: ActiveRun): void {
    const nodeId = active.snapshot.pendingPause?.nodeId;
    if (nodeId) {
      const state = active.snapshot.nodeStates[nodeId];
      if (state?.status === "paused") {
        active.snapshot.nodeStates[nodeId] = { ...state, status: "blocked" };
      }
    }
    active.snapshot.pendingPause = undefined;
    active.snapshot.activeInterview = undefined;
  }

  private finishAttempt(
    active: ActiveRun,
    nodeId: string,
    attempt: number,
    status: "completed" | "failed",
    diagnostic?: PipelineRuntimeDiagnostic,
  ): void {
    const state = active.snapshot.nodeStates[nodeId];
    const attemptResults = [...(state.attemptResults ?? [])];
    const index = attemptResults.findIndex(item => item.attempt === attempt);
    const current = attemptResults[index] ?? { attempt, status: "running" as const, startedAt: state.startedAt ?? this.isoNow() };
    attemptResults[index < 0 ? attemptResults.length : index] = {
      ...current,
      status,
      completedAt: this.isoNow(),
      ...(diagnostic ? { diagnostic } : {}),
    };
    active.snapshot.nodeStates[nodeId] = { ...state, attemptResults };
  }

  private failNodeAttempt(
    active: ActiveRun,
    nodeId: string,
    attempt: number,
    diagnostic: PipelineRuntimeDiagnostic,
  ): void {
    active.snapshot.nodeStates[nodeId] = {
      ...active.snapshot.nodeStates[nodeId],
      status: "failed",
      completedAt: this.isoNow(),
    };
    this.finishAttempt(active, nodeId, attempt, "failed", diagnostic);
  }

  private startAttempt(active: ActiveRun, nodeId: string, attempt: number): void {
    const state = active.snapshot.nodeStates[nodeId];
    if (state.attemptResults?.some(item => item.attempt === attempt)) {
      active.snapshot.nodeStates[nodeId] = { ...state, status: "running", attempts: attempt };
      return;
    }
    const startedAt = this.isoNow();
    active.snapshot.nodeStates[nodeId] = {
      ...state,
      status: "running",
      attempts: attempt,
      startedAt: state.startedAt ?? startedAt,
      attemptResults: [...(state.attemptResults ?? []), { attempt, status: "running", startedAt }],
    };
  }

  private async requireActiveRun(runId: string): Promise<ActiveRun> {
    const active = this.runs.get(runId);
    if (!active) {
      const snapshot = await this.store?.load(runId);
      const program = snapshot ? this.programsById.get(snapshot.pipelineId) : undefined;
      if (!snapshot || !program) {
        throw new Error(`Unknown active pipeline run "${runId}".`);
      }
      if (snapshot.executionPlan) {
        const validation = validateExecutionPlanSnapshot(snapshot.executionPlan);
        if (!validation.snapshot || validation.errors.length > 0) {
          throw new Error(`Invalid persisted Execution Plan for run "${runId}": ${validation.errors.join(" ")}`);
        }
        snapshot.executionPlan = validation.snapshot;
      }
      const restored = {
        program,
        snapshot,
        controller: new AbortController(),
        sessions: new Map<string, AgentNodeSession>(),
        activityUnsubscribers: new Map<AgentNodeSession, () => void>(),
        closedSessions: new WeakSet<AgentNodeSession>(),
        nodeTasks: new Map<string, Promise<NodeTaskResult>>(),
        explicitRetryNodes: new Set<string>(),
        terminalFailure: terminalFailureFromSnapshot(snapshot),
      };
      this.runs.set(runId, restored);
      return restored;
    }
    return active;
  }

  private captureExecutionPlan(
    active: ActiveRun,
    artifact: PipelineArtifact,
  ): PipelineRuntimeDiagnostic | undefined {
    // Markdown keeps the human adapter contract; only the structured JSON
    // artifact is authoritative enough to freeze into an Execution Plan.
    if (!artifact.type.startsWith("acp.ticket-graph/") || artifact.format !== "json") return undefined;
    if (artifact.type !== "acp.ticket-graph/v1") {
      return {
        nodeId: artifact.producerNodeId,
        code: "unsupported_ticket_graph_version",
        message: `Unsupported Ticket Graph contract "${artifact.type}".`,
      };
    }
    const compiled = compileExecutionPlan(artifact.value);
    if (!compiled.plan) {
      return {
        nodeId: artifact.producerNodeId,
        code: "invalid_execution_plan",
        message: compiled.errors.join(" "),
      };
    }
    if (active.snapshot.executionPlan) {
      if (JSON.stringify(active.snapshot.executionPlan.plan) === JSON.stringify(compiled.plan)) return undefined;
      return {
        nodeId: artifact.producerNodeId,
        code: "execution_plan_frozen",
        message: "A different Ticket Graph requires a new Execution Plan version; the active plan is frozen.",
      };
    }
    active.snapshot.executionPlan = {
      plan: compiled.plan,
      expansion: { status: "pending", expandedNodeIds: [] },
    };
    return undefined;
  }

  private acceptArtifact(active: ActiveRun, artifact: PipelineArtifact): PipelineRuntimeDiagnostic | undefined {
    const planError = this.captureExecutionPlan(active, artifact);
    if (planError) return planError;
    active.snapshot.artifacts[artifactKey(artifact.producerNodeId, artifact.name)] = artifact;
    return undefined;
  }

  private async persist(snapshot: PipelineRuntimeSnapshot): Promise<void> {
    await this.store?.save(cloneSnapshot(snapshot));
  }

  private async persistSandboxRunState(
    active: ActiveRun,
    state: NonNullable<PipelineRuntimeSnapshot["sandboxRuns"]>[string],
  ): Promise<void> {
    if (state.runId !== active.snapshot.runId) {
      throw new Error(`Sandbox Run "${state.sandboxName}" belongs to run "${state.runId}", not "${active.snapshot.runId}".`);
    }
    active.snapshot.sandboxRuns = {
      ...active.snapshot.sandboxRuns,
      [state.sandboxName]: cloneJson(state),
    };
    active.snapshot.updatedAt = this.isoNow();
    await this.persist(active.snapshot);
  }

  private resumeSandboxRun(
    active: ActiveRun,
    nodeId: string,
    attempt: number,
  ): NonNullable<PipelineRuntimeSnapshot["sandboxRuns"]>[string] | undefined {
    return Object.values(active.snapshot.sandboxRuns ?? {}).find(state =>
      state.nodeId === nodeId && state.attempt === attempt
    );
  }

  private recordInterviewHistory(active: ActiveRun, interview: NonNullable<PipelineRuntimeSnapshot["activeInterview"]>): void {
    // L'historique est aussi publié comme artefact structuré : une reprise peut
    // reconstruire l'entretien sans dépendre des chunks de diagnostic éphémères.
    const history = cloneJson(interview);
    active.snapshot.nodeInterviewHistories = {
      ...active.snapshot.nodeInterviewHistories,
      [interview.nodeId]: history,
    };
    active.snapshot.artifacts[artifactKey(interview.nodeId, PIPELINE_NODE_ACP_HISTORY_ARTIFACT_NAME)] = {
      name: PIPELINE_NODE_ACP_HISTORY_ARTIFACT_NAME,
      type: PIPELINE_NODE_ACP_HISTORY_ARTIFACT_TYPE,
      format: "json",
      value: history,
      producerNodeId: interview.nodeId,
    };
  }

  private async openAttemptSession(active: ActiveRun, node: CompiledPipelineNode): Promise<AgentNodeSession> {
    const session = await this.adapter.createSession({ runId: active.snapshot.runId, node, signal: active.controller.signal });
    await assertSessionBoundary(active.snapshot.runId, node.id, session);
    this.subscribeSessionActivity(active, session);
    active.sessions.set(node.id, session);
    return session;
  }

  private async openInterviewSession(active: ActiveRun, node: CompiledPipelineNode): Promise<AgentNodeSession> {
    const existing = active.sessions.get(node.id);
    if (existing) {
      return existing;
    }
    const session = await this.adapter.createSession({ runId: active.snapshot.runId, node, signal: active.controller.signal });
    await assertSessionBoundary(active.snapshot.runId, node.id, session);
    this.subscribeSessionActivity(active, session);
    active.sessions.set(node.id, session);
    return session;
  }

  private async closeInterviewSession(active: ActiveRun, nodeId: string): Promise<void> {
    const session = active.sessions.get(nodeId);
    if (!session) {
      return;
    }
    active.sessions.delete(nodeId);
    await this.closeSessionForRun(active, session);
  }

  private async cancelActiveSessions(active: ActiveRun): Promise<void> {
    await Promise.all([...active.sessions.values()].map(async session => {
      this.unsubscribeSessionActivity(active, session);
      active.closedSessions.add(session);
      await session.cancel();
      await session.close();
    }));
    active.sessions.clear();
  }

  private async closeActiveSessions(active: ActiveRun): Promise<void> {
    await Promise.all([...active.sessions.values()].map(session => this.closeSessionForRun(active, session)));
    active.sessions.clear();
  }

  private subscribeSessionActivity(active: ActiveRun, session: AgentNodeSession): void {
    if (!session.onActivity || active.activityUnsubscribers.has(session)) {
      return;
    }
    const unsubscribe = session.onActivity(activity => {
      void this.emitRuntimeEvent({
        runId: active.snapshot.runId,
        type: "agent_activity",
        nodeId: session.nodeId,
        activity,
        message: activity.content,
        at: this.isoNow(),
      });
    });
    active.activityUnsubscribers.set(session, unsubscribe);
  }

  private unsubscribeSessionActivity(active: ActiveRun, session: AgentNodeSession): void {
    active.activityUnsubscribers.get(session)?.();
    active.activityUnsubscribers.delete(session);
  }

  private async closeSessionForRun(active: ActiveRun, session: AgentNodeSession): Promise<void> {
    // Plusieurs chemins terminaux convergent ici (succès, retry, échec et
    // annulation). La fermeture doit rester idempotente pour ne pas envoyer deux
    // close au même transport ACP.
    if (active.closedSessions.has(session)) {
      return;
    }
    active.closedSessions.add(session);
    for (const [nodeId, activeSession] of active.sessions) {
      if (activeSession === session) {
        active.sessions.delete(nodeId);
      }
    }
    this.unsubscribeSessionActivity(active, session);
    await session.close();
  }

  private async emitRuntimeEvent(event: PipelineRuntimeEvent): Promise<void> {
    await this.onEvent?.(event);
    if (event.type === "agent_activity") {
      return;
    }
    await this.store?.appendEvent(event.runId, event);
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}

function dependencyCheckpoints(active: ActiveRun, node: CompiledPipelineNode) {
  const dependencies = active.program.nodes.filter(candidate =>
    node.needs.includes(candidate.id)
    && candidate.kind === "agent"
    && canMutateWorkspace(candidate.policy)
  );
  const checkpoints = dependencies.flatMap(dependency => {
    const dependencyNodeId = dependency.id;
    const latest = Object.values(active.snapshot.sandboxRuns ?? {})
      .filter(run => run.nodeId === dependencyNodeId && run.checkpoint)
      .sort((left, right) => right.attempt - left.attempt)[0];
    return latest?.checkpoint ? [{
      runId: latest.runId,
      nodeId: latest.nodeId,
      attempt: latest.attempt,
      sandboxName: latest.sandboxName,
      baseCommit: latest.baseCommit,
      checkpoint: structuredClone(latest.checkpoint),
    }] : [];
  });
  if (checkpoints.length !== dependencies.length) {
    const retained = new Set(checkpoints.map(checkpoint => checkpoint.nodeId));
    const missing = dependencies.map(dependency => dependency.id).filter(nodeId => !retained.has(nodeId));
    throw new Error(`Cannot prepare node "${node.id}": satisfied dependencies lack retained Agent Checkpoints: ${missing.join(", ")}.`);
  }
  return checkpoints;
}

function requiredCheckpointDiagnostic(
  active: ActiveRun,
  node: CompiledPipelineNode,
  attempt: number,
): PipelineRuntimeDiagnostic | undefined {
  if (!canMutateWorkspace(node.policy)) return undefined;
  const retained = Object.values(active.snapshot.sandboxRuns ?? {}).some(run =>
    run.runId === active.snapshot.runId
    && run.nodeId === node.id
    && run.attempt === attempt
    && Boolean(run.checkpoint)
  );
  return retained ? undefined : {
    nodeId: node.id,
    attempt,
    code: "missing_agent_checkpoint",
    message: `Workspace-writing node "${node.id}" completed attempt ${attempt} without retaining an Agent Checkpoint.`,
  };
}

function executionPlanNodes(plan: ExecutionPlan): CompiledPipelineNode[] {
  const implementationNodes = plan.nodes.map(node => ({
    id: node.id,
    kind: "agent" as const,
    agent: node.ticket.agent ?? "Codex Sandbox",
    prompt: `Implement the approved ticket from the immutable Execution Plan:\n${JSON.stringify(node.ticket, null, 2)}`,
    skills: ["implement"],
    needs: [...node.needs],
    inputs: [],
    output: { name: "result", type: "acp.implementation-result/v1", format: "json" as const },
    retry: { maxAttempts: 1, backoffMs: 0 },
    policy: WORKSPACE_WRITE_PIPELINE_POLICY,
  }));
  return [...implementationNodes, {
    id: plan.finalReview.id,
    kind: "agent" as const,
    agent: "Codex Sandbox",
    prompt: "Review the complete integrated result produced by the immutable Execution Plan.",
    skills: ["code-review"],
    needs: [...plan.finalReview.needs],
    inputs: [],
    output: { name: "review", type: "acp.verification-report/v1", format: "json" as const },
    retry: { maxAttempts: 1, backoffMs: 0 },
    policy: READ_ONLY_PIPELINE_POLICY,
  }];
}

function resolveInputs(node: CompiledPipelineNode, artifacts: Record<string, PipelineArtifact>): Record<string, PipelineArtifact> {
  const result: Record<string, PipelineArtifact> = {};
  for (const input of node.inputs) {
    const producer = parseArtifactProducer(input.from)!;
    result[input.name] = artifacts[artifactKey(producer.nodeId, producer.artifactName)];
  }
  return result;
}

export function renderRuntimeTemplate(
  template: string,
  inputVariables: Record<string, unknown>,
  inputs: Record<string, PipelineArtifact>,
): string {
  return template.replace(/{{\s*([^}]+?)\s*}}/g, (_match, variable: string) => {
    const key = variable.trim();
    if (key === "userPrompt") {
      return stringifyTemplateValue(inputVariables.userPrompt);
    }
    const inputMatch = /^inputs\.([A-Za-z][A-Za-z0-9_-]*)$/.exec(key);
    if (inputMatch) {
      return stringifyTemplateValue(inputs[inputMatch[1]]?.value);
    }
    return stringifyTemplateValue(inputVariables[key]);
  });
}

function assertArtifact(node: CompiledPipelineNode, result: PipelineNodeExecutionResult): PipelineArtifact {
  if (!("artifact" in result)) {
    throw new Error("Expected successful node result.");
  }
  if (!node.output) {
    throw new Error(`Node "${node.id}" cannot publish an artifact.`);
  }
  if (result.artifact.name !== node.output.name) {
    throw new Error(`Node "${node.id}" returned artifact "${result.artifact.name}" instead of "${node.output.name}".`);
  }
  if (result.artifact.type !== node.output.type) {
    throw new Error(`Node "${node.id}" returned artifact type "${result.artifact.type}" instead of "${node.output.type}".`);
  }
  if (result.artifact.format !== node.output.format) {
    throw new Error(`Node "${node.id}" returned artifact format "${result.artifact.format}" instead of "${node.output.format}".`);
  }
  return { ...result.artifact, producerNodeId: node.id };
}

function artifactKey(nodeId: string, artifactName: string): string {
  return `${nodeId}.${artifactName}`;
}

function isInterviewTransportLoss(result: PipelineNodeExecutionFailure): boolean {
  return result.retryable === true && result.code === "transport_lost";
}

class InvalidAgentNodeSessionError extends Error {
  readonly code = "invalid_agent_node_session";

  constructor(message: string) {
    super(message);
    this.name = "InvalidAgentNodeSessionError";
  }
}

async function assertSessionBoundary(runId: string, nodeId: string, session: AgentNodeSession): Promise<void> {
  if (session.runId === runId && session.nodeId === nodeId) {
    return;
  }
  await session.close();
  throw new InvalidAgentNodeSessionError(
    `AgentNodeSession for run "${session.runId}" and node "${session.nodeId}" cannot be used for run "${runId}" and node "${nodeId}".`,
  );
}

function sessionBoundaryDiagnostic(
  active: ActiveRun,
  node: CompiledPipelineNode,
  attempt: number,
  error: unknown,
): PipelineRuntimeDiagnostic {
  const message = error instanceof Error && error.message ? error.message : String(error);
  return {
    nodeId: node.id,
    attempt,
    code: error instanceof InvalidAgentNodeSessionError ? error.code : "agent_session_open_failed",
    message,
  };
}

function cloneSnapshot(snapshot: PipelineRuntimeSnapshot): PipelineRuntimeSnapshot {
  return cloneJson(snapshot);
}

function terminalFailureFromSnapshot(snapshot: PipelineRuntimeSnapshot): PipelineRuntimeDiagnostic | undefined {
  const failedNodeIds = new Set(
    Object.entries(snapshot.nodeStates)
      .filter(([, state]) => state.status === "failed")
      .map(([nodeId]) => nodeId),
  );
  return [...snapshot.diagnostics].reverse()
    .find(diagnostic => diagnostic.nodeId !== undefined && failedNodeIds.has(diagnostic.nodeId));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneInputVariables(inputs: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!inputs) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(inputs)) as Record<string, unknown>;
}

function stringifyTemplateValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value) ?? "";
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}
