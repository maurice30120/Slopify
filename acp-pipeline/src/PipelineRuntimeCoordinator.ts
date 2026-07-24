import {
  PipelineRuntime as CorePipelineRuntime,
  type PipelineRunStore,
  type PipelineRuntimeEvent,
  type PipelineRuntimeOptions,
  type PipelineRuntimeStartOptions,
} from "./PipelineRuntime";
import type {
  PipelineChangeSetFinalizationInput,
  PipelineChangeSetFinalizationResult,
} from "./PipelineAgentRunner";
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
 * Adds a run-level finalization boundary around the core DAG runtime.
 *
 * The core runtime may reach its terminal graph state before the workspace
 * checkpoint coordinator completes. Completion persistence and events are
 * buffered so hosts observe exactly one terminal outcome after the global
 * Pipeline Change Set has been integrated and its Promotion decided.
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
      return Object.assign(result, {
        promotion: changeSet.promotion,
        changeSet,
      }) as CoordinatedPipelineRuntimeResult;
    } catch (error: unknown) {
      const diagnostic: PipelineRuntimeDiagnostic = {
        code: "pipeline_change_set_finalization_failed",
        message: error instanceof Error && error.message ? error.message : String(error),
      };
      const snapshot = structuredClone(result.snapshot);
      snapshot.status = "failed";
      snapshot.diagnostics.push(diagnostic);
      snapshot.updatedAt = new Date().toISOString();
      await this.completionBuffer.fail(result.runId, snapshot, diagnostic);
      return {
        status: "failed",
        runId: result.runId,
        error: diagnostic,
        snapshot,
      };
    } finally {
      this.cleanupRun(result.runId);
    }
  }

  private cleanupRun(runId: string): void {
    this.programsByRunId.delete(runId);
  }
}

interface BufferedCompletion {
  snapshot?: PipelineRuntimeSnapshot;
  event?: PipelineRuntimeEvent;
}

class PipelineCompletionBuffer {
  private readonly completions = new Map<string, BufferedCompletion>();
  readonly store?: PipelineRunStore;

  constructor(
    private readonly targetStore: PipelineRunStore | undefined,
    private readonly targetOnEvent: PipelineRuntimeOptions["onEvent"],
  ) {
    if (!targetStore) {
      return;
    }
    this.store = {
      create: snapshot => targetStore.create(snapshot),
      load: runId => targetStore.load(runId),
      listResumable: () => targetStore.listResumable(),
      save: async snapshot => {
        if (snapshot.status === "completed") {
          this.completion(snapshot.runId).snapshot = structuredClone(snapshot);
          return;
        }
        await targetStore.save(snapshot);
      },
      appendEvent: async (runId, event) => {
        if (event.type === "completed") {
          this.completion(runId).event = { ...event };
          return;
        }
        await targetStore.appendEvent(runId, event);
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
    this.completions.delete(runId);
    if (completion.snapshot) {
      await this.targetStore?.save(completion.snapshot);
    }
    if (completion.event) {
      await this.targetOnEvent?.(completion.event);
      await this.targetStore?.appendEvent(runId, completion.event);
    }
  }

  async fail(
    runId: string,
    snapshot: PipelineRuntimeSnapshot,
    diagnostic: PipelineRuntimeDiagnostic,
  ): Promise<void> {
    this.completions.delete(runId);
    await this.targetStore?.save(snapshot);
    const event: PipelineRuntimeEvent = {
      runId,
      type: "failed",
      nodeId: diagnostic.nodeId,
      message: diagnostic.message,
      at: snapshot.updatedAt,
    };
    await this.targetOnEvent?.(event);
    await this.targetStore?.appendEvent(runId, event);
  }

  async cancel(
    runId: string,
    snapshot: PipelineRuntimeSnapshot,
    message: string,
  ): Promise<void> {
    this.completions.delete(runId);
    await this.targetStore?.save(snapshot);
    const event: PipelineRuntimeEvent = {
      runId,
      type: "cancelled",
      message,
      at: snapshot.updatedAt,
    };
    await this.targetOnEvent?.(event);
    await this.targetStore?.appendEvent(runId, event);
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
}

/**
 * Orders selected nodes by DAG level, then by their declaration position.
 * Completion timing never participates in the comparison.
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
