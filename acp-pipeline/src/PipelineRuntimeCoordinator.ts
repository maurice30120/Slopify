import {
  PipelineRuntime as CorePipelineRuntime,
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
 * Agents still execute and finish independently inside the core runtime. Once
 * the complete DAG succeeds, an adapter may integrate every retained workspace
 * checkpoint and make one final Promotion decision for the whole run.
 */
export class PipelineRuntime extends CorePipelineRuntime {
  private readonly programsByRunId = new Map<string, CompiledPipelineProgram>();
  private readonly programsById = new Map<string, CompiledPipelineProgram>();
  private readonly finalizedRunIds = new Set<string>();
  private readonly finalizer?: PipelineChangeSetFinalizingAdapter["finalizePipelineChangeSet"];

  constructor(
    adapter: PipelineRuntimeAdapter,
    options: PipelineRuntimeOptions = {},
  ) {
    super(adapter, options);
    const adapterFinalizer = (adapter as PipelineChangeSetFinalizingAdapter).finalizePipelineChangeSet;
    const factoryFinalizer = (adapter.createSession as PipelineChangeSetFinalizingSessionFactory).finalizePipelineChangeSet;
    this.finalizer = adapterFinalizer?.bind(adapter) ?? factoryFinalizer?.bind(adapter.createSession);
    for (const program of options.programs ?? []) {
      this.programsById.set(program.id, program);
    }
  }

  override async start(
    program: CompiledPipelineProgram,
    options: PipelineRuntimeStartOptions = {},
  ): Promise<PipelineRuntimeResult> {
    this.programsById.set(program.id, program);
    const result = await super.start(program, options);
    this.programsByRunId.set(result.runId, program);
    return this.finalizeCompletedResult(result, program);
  }

  override async resume(
    runId: string,
    decision: PipelineResumeDecision,
  ): Promise<PipelineRuntimeResult> {
    const result = await super.resume(runId, decision);
    const program = this.programsByRunId.get(runId)
      ?? this.programsById.get(result.snapshot.pipelineId);
    if (!program) {
      return result;
    }
    return this.finalizeCompletedResult(result, program);
  }

  override async cancel(runId: string): Promise<PipelineRuntimeResult> {
    try {
      return await super.cancel(runId);
    } finally {
      this.cleanupRun(runId);
    }
  }

  private async finalizeCompletedResult(
    result: PipelineRuntimeResult,
    program: CompiledPipelineProgram,
  ): Promise<PipelineRuntimeResult> {
    if (result.status !== "completed" || !this.finalizer || this.finalizedRunIds.has(result.runId)) {
      if (result.status !== "paused") {
        this.cleanupRun(result.runId);
      }
      return result;
    }

    this.finalizedRunIds.add(result.runId);
    try {
      const changeSet = await this.finalizer({ runId: result.runId, program });
      if (!changeSet) {
        return result;
      }
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
