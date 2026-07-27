import {
  PipelineRuntime as CorePipelineRuntime,
  type PipelineRunStore,
  type PipelineRuntimeEvent,
  type PipelineRuntimeOptions,
  type PipelineRuntimeStartOptions,
} from "./PipelineRuntime";
import { InMemoryPipelineRunStore } from "./PipelineRunStore";
import type {
  PipelineChangeSetFinalizationInput,
  PipelineChangeSetFinalizationResult,
} from "./PipelineAgentRunner";
import { PipelineIntegrationConflictError } from "./PipelineAgentRunner";
import type {
  CompiledPipelineNode,
  CompiledPipelineProgram,
  PipelineResumeDecision,
  PipelineRuntimeAdapter,
  PipelineRuntimeDiagnostic,
  PipelineRuntimeResult,
  PipelineRuntimeSnapshot,
} from "./PipelineV3Types";

interface PipelineChangeSetFinalizingAdapter extends PipelineRuntimeAdapter {
  finalizePipelineChangeSet?(
    input: PipelineChangeSetFinalizationInput,
  ): Promise<PipelineChangeSetFinalizationResult | undefined>;
}

interface PipelineChangeSetFinalizingSessionFactory {
  finalizePipelineChangeSet?(
    input: PipelineChangeSetFinalizationInput,
  ): Promise<PipelineChangeSetFinalizationResult | undefined>;
}

export type CoordinatedPipelineRuntimeResult = PipelineRuntimeResult & {
  promotion?: PipelineChangeSetFinalizationResult["promotion"];
  changeSet?: PipelineChangeSetFinalizationResult;
};

/**
 * Ajoute au runtime du DAG une frontière de finalisation à l'échelle du run.
 *
 * Le graphe peut atteindre son état terminal avant la fin de l'intégration des
 * Agent Checkpoints. La persistance et l'événement `completed` sont donc mis en
 * mémoire tampon : l'hôte ne doit observer qu'un seul état terminal, après
 * intégration du Pipeline Change Set et décision de Promotion.
 *
 * Voir `docs/adr/0002-promote-one-multi-agent-change-set.md`.
 */
export class PipelineRuntime extends CorePipelineRuntime {
  private readonly programsByRunId = new Map<string, CompiledPipelineProgram>();
  private readonly coordinatedProgramsById = new Map<string, CompiledPipelineProgram>();
  private readonly finalizer?: PipelineChangeSetFinalizingAdapter["finalizePipelineChangeSet"];
  private readonly completionBuffer: PipelineCompletionBuffer;

  constructor(
    adapter: PipelineRuntimeAdapter,
    options: PipelineRuntimeOptions = {},
  ) {
    const completionBuffer = new PipelineCompletionBuffer(options.store, options.onEvent);
    super(adapter, {
      ...options,
      store: completionBuffer.store,
      onEvent: event => completionBuffer.captureEvent(event),
    });
    this.completionBuffer = completionBuffer;
    const adapterFinalizer = (adapter as PipelineChangeSetFinalizingAdapter).finalizePipelineChangeSet;
    const factoryFinalizer = (adapter.createSession as unknown as PipelineChangeSetFinalizingSessionFactory).finalizePipelineChangeSet;
    this.finalizer = adapterFinalizer?.bind(adapter) ?? factoryFinalizer?.bind(adapter.createSession);
    for (const program of options.programs ?? []) {
      this.coordinatedProgramsById.set(program.id, program);
    }
  }

  override async start(
    program: CompiledPipelineProgram,
    options: PipelineRuntimeStartOptions = {},
  ): Promise<PipelineRuntimeResult> {
    this.coordinatedProgramsById.set(program.id, program);
    const result = await super.start(program, options);
    this.programsByRunId.set(result.runId, program);
    return this.finalizeTerminalResult(result, program);
  }

  override async resume(
    runId: string,
    decision: PipelineResumeDecision,
  ): Promise<PipelineRuntimeResult> {
    const snapshot = await this.inspect(runId);
    const conflict = snapshot?.pendingPause?.integrationConflict;
    if (
      conflict
      && snapshot.pendingPause?.id === decision.pauseId
      && decision.kind === "approve"
    ) {
      const program = this.programsByRunId.get(runId)
        ?? this.coordinatedProgramsById.get(snapshot.pipelineId);
      const result = await super.retryNode(runId, conflict.retryNodeId, decision.pauseId);
      return program ? this.finalizeTerminalResult(result, program) : result;
    }
    const result = await super.resume(runId, decision);
    const program = this.programsByRunId.get(runId)
      ?? this.coordinatedProgramsById.get(result.snapshot.pipelineId);
    if (!program) {
      await this.completionBuffer.flush(runId);
      return result;
    }
    return this.finalizeTerminalResult(result, program);
  }

  override async cancel(runId: string): Promise<PipelineRuntimeResult> {
    try {
      return await super.cancel(runId);
    } finally {
      this.cleanupRun(runId);
    }
  }

  private async finalizeTerminalResult(
    result: PipelineRuntimeResult,
    program: CompiledPipelineProgram,
  ): Promise<PipelineRuntimeResult> {
    if (result.status !== "completed") {
      if (result.status !== "paused") {
        this.cleanupRun(result.runId);
      }
      return result;
    }

    if (!this.finalizer) {
      await this.completionBuffer.flush(result.runId);
      this.cleanupRun(result.runId);
      return result;
    }

    try {
      const changeSet = await this.finalizer({ runId: result.runId, program });
      if (!changeSet) {
        await this.completionBuffer.flush(result.runId);
        this.cleanupRun(result.runId);
        return result;
      }
      if (changeSet.promotion === "rejected" || changeSet.promotion === "cancelled") {
        const snapshot = structuredClone(result.snapshot);
        snapshot.status = "cancelled";
        snapshot.updatedAt = new Date().toISOString();
        await this.completionBuffer.cancel(
          result.runId,
          snapshot,
          `Pipeline Change Set Promotion ${changeSet.promotion}.`,
        );
        this.cleanupRun(result.runId);
        return Object.assign({
          status: "cancelled" as const,
          runId: result.runId,
          snapshot,
        }, {
          promotion: changeSet.promotion,
          changeSet,
        }) as CoordinatedPipelineRuntimeResult;
      }
      await this.completionBuffer.flush(result.runId);
      this.cleanupRun(result.runId);
      return Object.assign(result, {
        promotion: changeSet.promotion,
        changeSet,
      }) as CoordinatedPipelineRuntimeResult;
    } catch (error: unknown) {
      if (error instanceof PipelineIntegrationConflictError) {
        const snapshot = structuredClone(result.snapshot);
        const pause = integrationConflictPause(error);
        snapshot.status = "paused";
        snapshot.pendingPause = pause;
        snapshot.updatedAt = new Date().toISOString();
        await this.completionBuffer.pause(result.runId, snapshot, pause);
        return {
          status: "paused",
          runId: result.runId,
          pause,
          snapshot,
        };
      }
      const diagnostic: PipelineRuntimeDiagnostic = {
        code: "pipeline_change_set_finalization_failed",
        message: error instanceof Error && error.message ? error.message : String(error),
      };
      const snapshot = structuredClone(result.snapshot);
      snapshot.status = "failed";
      snapshot.diagnostics.push(diagnostic);
      snapshot.updatedAt = new Date().toISOString();
      await this.completionBuffer.fail(result.runId, snapshot, diagnostic);
      this.cleanupRun(result.runId);
      return {
        status: "failed",
        runId: result.runId,
        error: diagnostic,
        snapshot,
      };
    }
  }

  private cleanupRun(runId: string): void {
    this.programsByRunId.delete(runId);
  }
}

interface BufferedCompletion {
  snapshot?: PipelineRuntimeSnapshot;
  event?: PipelineRuntimeEvent;
  snapshotPersisted?: boolean;
  eventPersisted?: boolean;
  eventEmitted?: boolean;
}

class PipelineCompletionBuffer {
  private readonly completions = new Map<string, BufferedCompletion>();
  private readonly backingStore: PipelineRunStore;
  private readonly fallbackStore?: InMemoryPipelineRunStore;
  readonly store: PipelineRunStore;

  constructor(
    targetStore: PipelineRunStore | undefined,
    private readonly targetOnEvent: PipelineRuntimeOptions["onEvent"],
  ) {
    this.fallbackStore = targetStore ? undefined : new InMemoryPipelineRunStore();
    this.backingStore = targetStore ?? this.fallbackStore!;
    this.store = {
      create: snapshot => this.backingStore.create(snapshot),
      load: runId => this.backingStore.load(runId),
      listResumable: () => this.backingStore.listResumable(),
      save: async snapshot => {
        if (snapshot.status === "completed") {
          this.completion(snapshot.runId).snapshot = structuredClone(snapshot);
          return;
        }
        await this.backingStore.save(snapshot);
      },
      appendEvent: async (runId, event) => {
        if (event.type === "completed") {
          this.completion(runId).event = { ...event };
          return;
        }
        await this.backingStore.appendEvent(runId, event);
      },
    };
  }

  async captureEvent(event: PipelineRuntimeEvent): Promise<void> {
    if (event.type === "completed") {
      this.completion(event.runId).event = { ...event };
      return;
    }
    await this.targetOnEvent?.(event);
  }

  async flush(runId: string): Promise<void> {
    const completion = this.completions.get(runId);
    if (!completion) {
      return;
    }
    if (completion.snapshot && !completion.snapshotPersisted) {
      await this.backingStore.save(completion.snapshot);
      completion.snapshotPersisted = true;
    }
    if (completion.event && !completion.eventPersisted) {
      await this.backingStore.appendEvent(runId, completion.event);
      completion.eventPersisted = true;
    }
    if (completion.event && !completion.eventEmitted) {
      await this.targetOnEvent?.(completion.event);
      completion.eventEmitted = true;
    }
    this.completions.delete(runId);
    await this.releaseFallbackRun(runId);
  }

  async fail(
    runId: string,
    snapshot: PipelineRuntimeSnapshot,
    diagnostic: PipelineRuntimeDiagnostic,
  ): Promise<void> {
    await this.backingStore.save(snapshot);
    const event: PipelineRuntimeEvent = {
      runId,
      type: "failed",
      nodeId: diagnostic.nodeId,
      message: diagnostic.message,
      at: snapshot.updatedAt,
    };
    await this.backingStore.appendEvent(runId, event);
    await this.targetOnEvent?.(event);
    this.completions.delete(runId);
    await this.releaseFallbackRun(runId);
  }

  async pause(
    runId: string,
    snapshot: PipelineRuntimeSnapshot,
    pause: NonNullable<PipelineRuntimeSnapshot["pendingPause"]>,
  ): Promise<void> {
    await this.backingStore.save(snapshot);
    const event: PipelineRuntimeEvent = {
      runId,
      type: "paused",
      nodeId: pause.nodeId,
      message: pause.content,
      at: snapshot.updatedAt,
    };
    await this.backingStore.appendEvent(runId, event);
    await this.targetOnEvent?.(event);
    this.completions.delete(runId);
  }

  async cancel(
    runId: string,
    snapshot: PipelineRuntimeSnapshot,
    message: string,
  ): Promise<void> {
    await this.backingStore.save(snapshot);
    const event: PipelineRuntimeEvent = {
      runId,
      type: "cancelled",
      message,
      at: snapshot.updatedAt,
    };
    await this.backingStore.appendEvent(runId, event);
    await this.targetOnEvent?.(event);
    this.completions.delete(runId);
    await this.releaseFallbackRun(runId);
  }

  private completion(runId: string): BufferedCompletion {
    const existing = this.completions.get(runId);
    if (existing) {
      return existing;
    }
    const created: BufferedCompletion = {};
    this.completions.set(runId, created);
    return created;
  }

  private async releaseFallbackRun(runId: string): Promise<void> {
    await this.fallbackStore?.delete(runId);
  }
}

function integrationConflictPause(error: PipelineIntegrationConflictError): NonNullable<PipelineRuntimeSnapshot["pendingPause"]> {
  const conflict = error.conflict;
  const checkpointLines = conflict.checkpoints
    .map(checkpoint => `- ${checkpoint.nodeId}, tentative ${checkpoint.attempt}`)
    .join("\n");
  const fileLines = conflict.files.length > 0
    ? conflict.files.map(file => `- ${file}`).join("\n")
    : "- fichiers inconnus";
  const attempt = conflict.checkpoints.find(checkpoint => checkpoint.nodeId === conflict.retryNodeId)?.attempt ?? 0;
  return {
    id: `${conflict.runId}:${conflict.retryNodeId}:integration-conflict:${attempt}`,
    nodeId: conflict.retryNodeId,
    type: "approval",
    format: "markdown",
    integrationConflict: conflict,
    content: [
      "## Integration Conflict",
      "",
      "Le Pipeline Change Set ne peut pas être intégré.",
      "",
      "Checkpoints impliqués:",
      checkpointLines,
      "",
      "Fichiers en conflit:",
      fileLines,
      "",
      "Aucun changement n'a été transféré vers le workspace hôte.",
      "Aucune résolution automatique ni Promotion n'a eu lieu.",
      "",
      `Approuver pour relancer uniquement le nœud ${conflict.retryNodeId}.`,
    ].join("\n"),
  };
}

/**
 * Ordonne les nœuds par niveau dans le DAG, puis par ordre de déclaration.
 * L'ordre de terminaison des agents ne doit jamais influencer l'intégration :
 * un même ensemble d'Agent Checkpoints doit produire le même Pipeline Change Set.
 *
 * Voir `docs/adr/0002-promote-one-multi-agent-change-set.md`.
 */
export function orderPipelineNodeIdsForIntegration(
  program: CompiledPipelineProgram,
  nodeIds: Iterable<string>,
): string[] {
  const selected = new Set(nodeIds);
  const declarationIndex = new Map(program.nodes.map((node, index) => [node.id, index] as const));
  const levelByNodeId = new Map<string, number>();

  for (const nodeId of selected) {
    if (!program.nodesById.has(nodeId)) {
      throw new Error(`Cannot integrate checkpoint for unknown pipeline node "${nodeId}".`);
    }
  }

  const levelOf = (node: CompiledPipelineNode): number => {
    const cached = levelByNodeId.get(node.id);
    if (cached !== undefined) {
      return cached;
    }
    const level = node.needs.length === 0
      ? 0
      : Math.max(...node.needs.map(dependency => levelOf(program.nodesById.get(dependency)!))) + 1;
    levelByNodeId.set(node.id, level);
    return level;
  };

  return program.nodes
    .filter(node => selected.has(node.id))
    .sort((left, right) => {
      const levelDifference = levelOf(left) - levelOf(right);
      if (levelDifference !== 0) {
        return levelDifference;
      }
      return declarationIndex.get(left.id)! - declarationIndex.get(right.id)!;
    })
    .map(node => node.id);
}
