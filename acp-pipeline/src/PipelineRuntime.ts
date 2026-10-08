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

/** Contrat fonctionnel de PipelineRuntimeOptions dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineRuntimeOptions {
  runIdFactory?: () => string;
  now?: () => Date;
  store?: PipelineRunStore;
  programs?: CompiledPipelineProgram[];
  onEvent?: (event: PipelineRuntimeEvent) => void | Promise<void>;
  adapterName?: string;
  adapterCapabilities?: PipelineAdapterPolicyCapabilities;
  resolveNodeSkills?: (node: CompiledPipelineNode) => string[] | Promise<string[]>;
  /** Agent choisi par l'hôte pour les nœuds ajoutés dynamiquement au plan d'exécution. */
  agentName?: string;
}

/** Contrat fonctionnel de PipelineRuntimeEvent dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
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

/** Contrat fonctionnel de PipelineRuntimeStartOptions dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineRuntimeStartOptions {
  inputs?: Record<string, unknown>;
  executionPlan?: ExecutionPlan;
  maxConcurrency?: number;
}

/** Contrat fonctionnel de PipelineRunStore dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineRunStore {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  create(snapshot: PipelineRuntimeSnapshot): Promise<void>;
/** Valide ou résout les données de cette étape du cycle de vie ; les entrées invalides restent signalées au point d'appel. */
  load(runId: string): Promise<PipelineRuntimeSnapshot | null>;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  save(snapshot: PipelineRuntimeSnapshot): Promise<void>;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  appendEvent(runId: string, event: PipelineRuntimeEvent): Promise<void>;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  listResumable(): Promise<PipelineRuntimeSnapshot[]>;
}

/** Contrat fonctionnel de ActiveRun dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
interface ActiveRun {
  program: CompiledPipelineProgram;
  snapshot: PipelineRuntimeSnapshot;
  controller: AbortController;
  sessions: Map<string, AgentNodeSession>;
  activityUnsubscribers: Map<AgentNodeSession, () => void>;
  closedSessions: WeakSet<AgentNodeSession>;
  nodeTasks: Map<string, Promise<NodeTaskResult>>;
  explicitRetryNodes: Set<string>;
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
  private readonly agentName?: string;

/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
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
    this.agentName = options.agentName;
    for (const program of options.programs ?? []) {
      this.programsById.set(program.id, program);
    }
  }

/**
 * Démarre un run à partir d'un programme compilé et avance jusqu'à une transition observable.
 * Chaque snapshot est persisté avant son événement ; une pause peut donc être reprise sans perdre
 * les Agent Checkpoints ni les artefacts déjà produits.
 * @param program DAG compilé et figé pour ce run.
 * @param options Variables, plan d'exécution et limite de concurrence du run.
 * @returns L'état terminal ou la pause qui exige une décision de l'hôte.
 * @throws Error si les options ou l'Execution Plan sont invalides.
 */
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

/**
 * Reprend un run suspendu après une question, une approbation ou une Promotion.
 * Une Rejection termine le run ; une réponse valide réactive uniquement le nœud concerné.
 * @param runId Identifiant durable du run suspendu.
 * @param decision Décision liée exactement à l'identifiant de pause courant.
 * @returns Le nouvel état du run après persistance et progression du DAG.
 * @throws Error si le run n'est pas actif ou si la session est irrécupérable.
 */
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

/**
 * Réinitialise un nœud terminé après un Integration Conflict pour retenter son intégration.
 * Les artefacts produits par ce nœud sont retirés, tandis que les résultats des autres nœuds restent durables.
 * @param runId Identifiant du run suspendu.
 * @param nodeId Nœud agent à retenter.
 * @param pauseId Identifiant de la pause d'Integration Conflict autorisant la reprise.
 * @returns Le nouvel état du run après relance du DAG.
 */
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
    };
    active.snapshot.pendingPause = undefined;
    active.snapshot.status = "running";
    active.snapshot.updatedAt = this.isoNow();
    active.explicitRetryNodes.add(nodeId);
    await this.persist(active.snapshot);
    await this.emitRuntimeEvent({ runId, type: "resumed", nodeId, at: active.snapshot.updatedAt });
    return this.advance(active);
  }

/**
 * Interrompt le run, annule les sessions ACP et persiste Cancellation pour chaque nœud actif.
 * Aucun nouvel artefact ni Pipeline Change Set n'est promu après cet appel.
 * @param runId Identifiant du run à annuler.
 * @returns L'état annulé persistant du run.
 */
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async inspect(runId: string): Promise<PipelineRuntimeSnapshot | null> {
    const active = this.runs.get(runId);
    if (active) {
      return cloneSnapshot(active.snapshot);
    }
    return this.store?.load(runId).then(snapshot => snapshot && cloneSnapshot(snapshot)) ?? null;
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private async advance(active: ActiveRun): Promise<PipelineRuntimeResult> {
    while (active.snapshot.status === "running") {
      const expansionError = await this.expandExecutionPlan(active);
      if (expansionError) return this.fail(active, expansionError);
      const ready = this.readyNodes(active);
      if (ready.length === 0 && active.nodeTasks.size === 0) {
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
        active.controller.abort();
        return this.fail(active, failure);
      }
      if ("paused" in result) {
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private startNodeTask(active: ActiveRun, node: CompiledPipelineNode): void {
    if (active.nodeTasks.has(node.id)) {
      return;
    }
    const task = this.executeNode(active, node)
      .then(result => ({ nodeId: node.id, result }))
      .catch((thrown: unknown) => ({ nodeId: node.id, thrown }));
    active.nodeTasks.set(node.id, task);
  }

/** Valide ou résout les données de cette étape du cycle de vie ; les entrées invalides restent signalées au point d'appel. */
  private readyNodes(active: ActiveRun): CompiledPipelineNode[] {
    return active.program.nodes
      .filter(node => active.snapshot.nodeStates[node.id]?.status === "pending")
      .filter(node => node.needs.every(dependency => active.snapshot.nodeStates[dependency]?.status === "completed"));
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private async expandExecutionPlan(active: ActiveRun): Promise<PipelineRuntimeDiagnostic | undefined> {
    const snapshot = active.snapshot.executionPlan;
    if (!snapshot) return undefined;
    const dynamicNodes = executionPlanNodes(snapshot.plan, this.agentName, active.program.nodes.find(node => node.output?.type === "acp.sequential-delivery/v1"), Object.values(active.snapshot.sandboxRuns ?? {}).find(run => run.baseCommit)?.baseCommit);
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private async executeNode(active: ActiveRun, node: CompiledPipelineNode): Promise<PipelineRuntimeDiagnostic | { ok: true } | { paused: PipelineRuntimeResult }> {
    const state = active.snapshot.nodeStates[node.id];
    const inputs = resolveInputs(node, active.snapshot.artifacts);
    const prompt = renderRuntimeTemplate(node.prompt ?? "", active.snapshot.inputVariables ?? {}, inputs);
    const skillErrors = this.resolveNodeSkills ? await this.resolveNodeSkills(node) : [];
    if (skillErrors.length > 0) {
      active.snapshot.nodeStates[node.id] = {
        ...state,
        status: "failed",
        attempts: state.attempts + 1,
        completedAt: this.isoNow(),
      };
      active.snapshot.updatedAt = this.isoNow();
      await this.persist(active.snapshot);
      return {
        nodeId: node.id,
        attempt: state.attempts + 1,
        code: "skill_resolution_failed",
        message: skillErrors.join("; "),
      };
    }
    const unsupportedPolicy = this.adapterCapabilities
      ? validateAdapterSupportsPolicy(this.adapterName, this.adapterCapabilities, node.policy)[0]
      : undefined;
    if (unsupportedPolicy) {
      active.snapshot.nodeStates[node.id] = {
        ...state,
        status: "failed",
        attempts: state.attempts + 1,
        completedAt: this.isoNow(),
      };
      active.snapshot.updatedAt = this.isoNow();
      await this.persist(active.snapshot);
      return {
        nodeId: node.id,
        attempt: state.attempts + 1,
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
      active.snapshot.nodeStates[node.id] = { ...state, status: "running", attempts: attempt, startedAt: state.startedAt ?? this.isoNow() };
      active.snapshot.updatedAt = this.isoNow();
      await this.persist(active.snapshot);
      await this.emitRuntimeEvent({ runId: active.snapshot.runId, type: "node_started", nodeId: node.id, at: active.snapshot.updatedAt });

      let session: AgentNodeSession;
      try {
        session = await this.openAttemptSession(active, node);
      } catch (error: unknown) {
        return sessionBoundaryDiagnostic(active, node, state.attempts + 1, error);
      }
      try {
        const dependencies = dependencyCheckpoints(active, node);
        const reviewPrompt = node.id === active.snapshot.executionPlan?.plan.finalReview.id
          ? `${prompt}\n\nComplete retained checkpoint evidence (diffs from the fixed run base):\n${dependencies.map(parent => `Node ${parent.nodeId}, base ${parent.baseCommit}, files: ${parent.checkpoint.preview.files.join(", ")}\n${parent.checkpoint.preview.diff}`).join("\n\n")}\n\nImplementation reports:\n${JSON.stringify(dependencies.map(parent => active.snapshot.artifacts[`${parent.nodeId}.result`]?.value).filter(Boolean))}\n\nPerform the static review now using this supplied complete diff and approved specification. Do not reread files or run exploratory tools. Report only evidence present here; do not claim to have run tests yourself. Return the verification JSON object as your final response.`
          : prompt;
        const result = await session.send({
          runId: active.snapshot.runId,
          attempt,
          node,
          prompt: reviewPrompt,
          inputs,
          signal: active.controller.signal,
          onSandboxRunState: state => this.persistSandboxRunState(active, state),
          resumeSandboxRun: this.resumeSandboxRun(active, node.id, attempt),
          dependencyCheckpoints: dependencies,
        });
        if (active.controller.signal.aborted) {
          return { ok: true };
        }
        if ("artifact" in result) {
          const checkpointError = requiredCheckpointDiagnostic(active, node, attempt);
          if (checkpointError) return checkpointError;
          const artifact = assertArtifact(node, result);
          const planError = this.acceptArtifact(active, artifact);
          if (planError) return planError;
          active.snapshot.nodeStates[node.id] = {
            ...active.snapshot.nodeStates[node.id],
            status: "completed",
            completedAt: this.isoNow(),
          };
          active.snapshot.updatedAt = this.isoNow();
          await this.persist(active.snapshot);
          await this.emitRuntimeEvent({ runId: active.snapshot.runId, type: "node_completed", nodeId: node.id, at: active.snapshot.updatedAt });
          return { ok: true };
        }

        active.snapshot.diagnostics.push({ nodeId: node.id, attempt, code: result.code, message: result.message });
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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
      active.snapshot.nodeStates[node.id] = {
        ...active.snapshot.nodeStates[node.id],
        status: "running",
        attempts: attempt,
        startedAt: active.snapshot.nodeStates[node.id].startedAt ?? this.isoNow(),
      };
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
          return sessionBoundaryDiagnostic(active, node, attempt, error);
        }
        const result = await session.send({
          runId: active.snapshot.runId,
          attempt,
          node,
          prompt,
          inputs,
          signal: active.controller.signal,
          onSandboxRunState: state => this.persistSandboxRunState(active, state),
          // Chaque envoi d'entretien porte un nouvel historique (ou une demande de réparation). Une
          // sandbox terminée appartient à l'envoi précédent, pas à ce prompt.
          resumeSandboxRun: this.resumeSandboxRun(active, node.id, attempt)?.integrationState === "sandbox_created"
            ? this.resumeSandboxRun(active, node.id, attempt)
            : undefined,
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
            await this.persist(active.snapshot);
            return { nodeId: node.id, attempt, code: result.code, message: result.message };
          }
          // Un historique ACP ne doit être rejoué que si la session distante a
          // été perdue. Une autre erreur retryable relance la tentative sans
          // dupliquer dans l'agent les tours déjà présents dans la session.
          const shouldReplayTransportLoss = isInterviewTransportLoss(result);
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
          if (checkpointError) return checkpointError;
          const artifact = assertArtifact(node, finalResult);
          const planError = this.acceptArtifact(active, artifact);
          if (planError) return planError;
          this.recordInterviewHistory(active, interview);
          active.snapshot.activeInterview = undefined;
          active.snapshot.nodeStates[node.id] = {
            ...active.snapshot.nodeStates[node.id],
            status: "completed",
            completedAt: this.isoNow(),
          };
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
          active.snapshot.updatedAt = this.isoNow();
          await this.persist(active.snapshot);
          return { nodeId: node.id, attempt, code: "malformed_interview_output", message };
        }
      }
    }
    return { nodeId: node.id, code: "retry_exhausted", message: `Node "${node.id}" exhausted retries.` };
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private async fail(active: ActiveRun, diagnostic: PipelineRuntimeDiagnostic): Promise<PipelineRuntimeResult> {
    active.snapshot.status = "failed";
    active.snapshot.diagnostics.push(diagnostic);
    for (const [nodeId, state] of Object.entries(active.snapshot.nodeStates)) {
      if (state.status === "pending" || state.status === "running") {
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private isComplete(active: ActiveRun): boolean {
    return active.program.nodes.every(node => active.snapshot.nodeStates[node.id]?.status === "completed");
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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
      };
      this.runs.set(runId, restored);
      return restored;
    }
    return active;
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private captureExecutionPlan(
    active: ActiveRun,
    artifact: PipelineArtifact,
  ): PipelineRuntimeDiagnostic | undefined {
    // Markdown conserve le contrat de l'adaptateur humain ; seul le JSON structuré
    // de l'artefact fait autorité pour figer un Execution Plan.
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private acceptArtifact(active: ActiveRun, artifact: PipelineArtifact): PipelineRuntimeDiagnostic | undefined {
    const planError = this.captureExecutionPlan(active, artifact);
    if (planError) return planError;
    active.snapshot.artifacts[artifactKey(artifact.producerNodeId, artifact.name)] = artifact;
    return undefined;
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private async persist(snapshot: PipelineRuntimeSnapshot): Promise<void> {
    await this.store?.save(cloneSnapshot(snapshot));
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private resumeSandboxRun(
    active: ActiveRun,
    nodeId: string,
    attempt: number,
  ): NonNullable<PipelineRuntimeSnapshot["sandboxRuns"]>[string] | undefined {
    return Object.values(active.snapshot.sandboxRuns ?? {}).find(state =>
      state.nodeId === nodeId && state.attempt === attempt
    );
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private async openAttemptSession(active: ActiveRun, node: CompiledPipelineNode): Promise<AgentNodeSession> {
    const session = await this.adapter.createSession({ runId: active.snapshot.runId, node, signal: active.controller.signal });
    await assertSessionBoundary(active.snapshot.runId, node.id, session);
    this.subscribeSessionActivity(active, session);
    active.sessions.set(node.id, session);
    return session;
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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

/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  private async closeInterviewSession(active: ActiveRun, nodeId: string): Promise<void> {
    const session = active.sessions.get(nodeId);
    if (!session) {
      return;
    }
    active.sessions.delete(nodeId);
    await this.closeSessionForRun(active, session);
  }

/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  private async cancelActiveSessions(active: ActiveRun): Promise<void> {
    await Promise.all([...active.sessions.values()].map(async session => {
      this.unsubscribeSessionActivity(active, session);
      active.closedSessions.add(session);
      await session.cancel();
      await session.close();
    }));
    active.sessions.clear();
  }

/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  private async closeActiveSessions(active: ActiveRun): Promise<void> {
    await Promise.all([...active.sessions.values()].map(session => this.closeSessionForRun(active, session)));
    active.sessions.clear();
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private unsubscribeSessionActivity(active: ActiveRun, session: AgentNodeSession): void {
    active.activityUnsubscribers.get(session)?.();
    active.activityUnsubscribers.delete(session);
  }

/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private async emitRuntimeEvent(event: PipelineRuntimeEvent): Promise<void> {
    await this.onEvent?.(event);
    if (event.type === "agent_activity") {
      return;
    }
    await this.store?.appendEvent(event.runId, event);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private isoNow(): string {
    return this.now().toISOString();
  }
}

/** Point d'entrée dependencyCheckpoints du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function dependencyCheckpoints(active: ActiveRun, node: CompiledPipelineNode) {
  // Les nœuds d'approbation transmettent les artefacts sans posséder de checkpoint. Parcourir
  // jusqu'aux agents écrivants les plus proches pour que les fichiers approuvés franchissent la frontière sandbox.
  const dependencyIds = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const candidate = active.program.nodesById.get(id);
    if (!candidate) return;
    if (candidate.kind === "agent" && canMutateWorkspace(candidate.policy)) dependencyIds.add(id);
    else candidate.needs.forEach(visit);
  };
  node.needs.forEach(visit);
  const dependencies = active.program.nodes.filter(candidate => dependencyIds.has(candidate.id));
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

/** Point d'entrée requiredCheckpointDiagnostic du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
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

/** Point d'entrée executionPlanNodes du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function executionPlanNodes(plan: ExecutionPlan, selectedAgent?: string, delivery?: CompiledPipelineNode, baseCommit?: string): CompiledPipelineNode[] {
  const inputs = delivery?.output ? [{ name: "approvedDelivery", from: `${delivery.id}.${delivery.output.name}`, type: delivery.output.type, format: delivery.output.format }] : [];
  const context = `User request:\n{{userPrompt}}\nApproved delivery (read the referenced specification and ticket files before making changes):\n{{inputs.approvedDelivery}}`;

  const implementationNodes = plan.nodes.map(node => ({
    id: node.id,
    kind: "agent" as const,
    agent: selectedAgent ?? node.ticket.agent ?? "Codex Sandbox",
    prompt: `${context}\nImplement the approved ticket from the immutable Execution Plan:\n${JSON.stringify(node.ticket, null, 2)}\nYour final assistant message MUST be the JSON object itself, not a description of fields or a plan to produce it. Fill this valid JSON template with actual evidence: ${JSON.stringify({ contract: "acp.implementation-result/v1", ticketId: node.id, branch: "actual branch name", commits: ["actual commit hash"], summary: "actual changes", validations: ["actual commands and results"] })}. Do not change public interfaces or add dependencies unless the approved ticket explicitly requires it. Use existing public operations to test private behavior. No Markdown or prose outside JSON.`,
    skills: ["implement"],
    needs: node.needs.length === 0 && delivery ? [delivery.id] : [...node.needs],
    inputs,
    output: { name: "result", type: "acp.implementation-result/v1", format: "json" as const },
    retry: { maxAttempts: 1, backoffMs: 0 },
    policy: WORKSPACE_WRITE_PIPELINE_POLICY,
  }));
  return [...implementationNodes, {
    id: plan.finalReview.id,
    kind: "agent" as const,
    agent: selectedAgent ?? "Codex Sandbox",
    prompt: `${context}\nReview the complete integrated result produced by the immutable Execution Plan against the approved specification, including exact formatting and tests. The fixed review base is ${baseCommit ?? "the first parent of the integration commit"}. Start with git diff --stat and git diff against this base. Review only files changed by this Execution Plan, plus the referenced specification/tickets and applicable repository standards. Earlier audit logs and unrelated historical changes are outside this delivery. Do not read whole source or test files: inspect only the changed hunks and at most 100 lines of adjacent context per read. Do not search audit directories or transcripts. Limit exploration to evidence needed to decide compliance, then publish the verdict immediately. Validate tests with npm ci and npm test at the root if needed; never pipe test output through tail without preserving the test exit status. Return the JSON object itself as your final assistant message. Fill this valid JSON template with actual evidence: {"contract":"acp.verification-report/v1","verdict":"passed","categories":[{"name":"spec compliance","required":true,"status":"passed","details":"actual evidence"}]}. Set verdict to failed when requirements fail; category status may be passed, failed or skipped. Check interface visibility, scope, dependencies and actual test results. Include at least one category. No Markdown or prose outside JSON.`,
    skills: ["code-review"],
    needs: [...plan.finalReview.needs],
    inputs,
    output: { name: "review", type: "acp.verification-report/v1", format: "json" as const },
    retry: { maxAttempts: 1, backoffMs: 0 },
    policy: READ_ONLY_PIPELINE_POLICY,
  }];
}

/** Point d'entrée resolveInputs du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function resolveInputs(node: CompiledPipelineNode, artifacts: Record<string, PipelineArtifact>): Record<string, PipelineArtifact> {
  const result: Record<string, PipelineArtifact> = {};
  for (const input of node.inputs) {
    const producer = parseArtifactProducer(input.from)!;
    result[input.name] = artifacts[artifactKey(producer.nodeId, producer.artifactName)];
  }
  return result;
}

/** Point d'entrée renderRuntimeTemplate du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
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
      const artifact = inputs[inputMatch[1]];
      const rendered = stringifyTemplateValue(artifact?.value);
      if (artifact?.type === "acp.ticket-graph/v1" && artifact.value && typeof artifact.value === "object") {
        const documentation = (artifact.value as { documentation?: unknown }).documentation;
        if (typeof documentation === "string" && /^\.scratch\/[^`\r\n]+$/.test(documentation)) {
          return `${rendered}\n\n\`${documentation}\``;
        }
      }
      return rendered;
    }
    return stringifyTemplateValue(inputVariables[key]);
  });
}

/** Point d'entrée assertArtifact du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
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

/** Point d'entrée artifactKey du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function artifactKey(nodeId: string, artifactName: string): string {
  return `${nodeId}.${artifactName}`;
}

/** Point d'entrée isInterviewTransportLoss du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function isInterviewTransportLoss(result: PipelineNodeExecutionFailure): boolean {
  return result.retryable === true && result.code === "transport_lost";
}

/** Composant InvalidAgentNodeSessionError qui coordonne une étape observable du cycle de vie du pipeline et en préserve les invariants. */
class InvalidAgentNodeSessionError extends Error {
  readonly code = "invalid_agent_node_session";

/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
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

/** Point d'entrée sessionBoundaryDiagnostic du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
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

/** Point d'entrée cloneSnapshot du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function cloneSnapshot(snapshot: PipelineRuntimeSnapshot): PipelineRuntimeSnapshot {
  return cloneJson(snapshot);
}

/** Point d'entrée cloneJson du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Point d'entrée cloneInputVariables du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function cloneInputVariables(inputs: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!inputs) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(inputs)) as Record<string, unknown>;
}

/** Point d'entrée stringifyTemplateValue du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
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

/** Point d'entrée sleep du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}
