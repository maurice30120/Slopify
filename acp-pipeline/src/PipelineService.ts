import { EventEmitter } from 'node:events';

import {
  publishPipelineArtifacts,
  type PipelineArtifactPublisher,
} from './PipelineArtifactPublisher';
import { PipelineRuntime } from './PipelineRuntime';
import type {
  AgentNodeSessionFactory,
  CompiledPipelineProgram,
  PipelinePauseSnapshot,
  PipelineResumeDecision,
  PipelineRuntimeResult,
} from './PipelineV3Types';

export type {
  PipelineStatus,
  PipelineStatusEvent,
  PipelinePlanReadyEvent,
  PipelineSessionUpdateEvent,
} from './PipelineEvents';

/** Contrat fonctionnel de PipelineServiceDependencies dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineServiceDependencies {
  getPipelinePrograms?: () => CompiledPipelineProgram[];
  getPipelineProgramForAgent?: (agentName: string) => CompiledPipelineProgram | null;
  getAgentConfigs?: () => Record<string, unknown>;
  createSession?: AgentNodeSessionFactory;
  onPipelineStart?: (input: { sessionId: string; program: CompiledPipelineProgram; workspaceCwd: string }) => void;
  isRunAbortedError?: (error: unknown) => boolean;
  artifactPublisher?: PipelineArtifactPublisher;
}

/** Composant PipelineService qui coordonne une étape observable du cycle de vie du pipeline et en préserve les invariants. */
export class PipelineService extends EventEmitter {
  private readonly v3Runs = new Map<string, PipelineRuntime>();
  private readonly v3RejectedRuns = new Set<string>();

/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
  constructor(
    private readonly workspaceCwd: () => string,
    private readonly dependencies: PipelineServiceDependencies = {},
  ) {
    super();
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async createPlan(sessionId: string, userPrompt: string, pipelineAgentName?: string): Promise<string> {
    return stringifyServiceResult(await this.startPipeline(sessionId, userPrompt, pipelineAgentName));
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async startPipeline(sessionId: string, userPrompt: string, pipelineAgentName?: string): Promise<PipelineRuntimeResult> {
    const program = this.readPipelineProgram(pipelineAgentName);
    if (!program) {
      throw new Error(
        pipelineAgentName
          ? `ACP pipeline "${pipelineAgentName}" was not found or is not a valid version 3 pipeline.`
          : 'No valid ACP version 3 pipelines found.',
      );
    }
    return this.startV3Pipeline(sessionId, program, userPrompt);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async approvePlan(sessionId: string, approvedPlan: string): Promise<string> {
    return stringifyServiceResult(await this.resumeCurrentPause(sessionId, "approve", approvedPlan.trim()));
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async resumePipeline(sessionId: string, decision: PipelineResumeDecision): Promise<PipelineRuntimeResult> {
    const runtime = this.v3Runs.get(sessionId);
    if (runtime) {
      return this.handleV3Result(
        sessionId,
        await runtime.resume(sessionId, decision),
      );
    }
    throw new Error('No pending pipeline pause for this session.');
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async resumeCurrentPause(
    sessionId: string,
    kind: PipelineResumeDecision["kind"],
    value?: unknown,
  ): Promise<PipelineRuntimeResult> {
    const pause = await this.getPendingPause(sessionId);
    if (!pause) {
      throw new Error('No pending pipeline pause for this session.');
    }
    return this.resumePipeline(sessionId, { pauseId: pause.id, kind, value });
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async getPendingPause(sessionId: string): Promise<PipelinePauseSnapshot | null> {
    const runtime = this.v3Runs.get(sessionId);
    if (!runtime) {
      return null;
    }
    const snapshot = await runtime.inspect(sessionId);
    return snapshot?.pendingPause ?? null;
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  rejectPlan(sessionId: string): void {
    const runtime = this.v3Runs.get(sessionId);
    if (runtime) {
      this.v3RejectedRuns.add(sessionId);
      void runtime.inspect(sessionId).then(snapshot => {
        const pause = snapshot?.pendingPause;
        if (pause) {
          void runtime.resume(sessionId, { pauseId: pause.id, kind: 'reject' })
            .then(result => this.handleV3Result(sessionId, result));
        } else {
          this.v3RejectedRuns.delete(sessionId);
        }
      });
      return;
    }
  }

/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  cancel(sessionId: string): void {
    const runtime = this.v3Runs.get(sessionId);
    if (runtime) {
      void runtime.cancel(sessionId);
      this.v3Runs.delete(sessionId);
      return;
    }
  }

/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  async dispose(): Promise<void> {
    for (const [sessionId, runtime] of this.v3Runs.entries()) {
      await runtime.cancel(sessionId);
    }
    this.v3Runs.clear();
    this.removeAllListeners();
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private async startV3Pipeline(
    sessionId: string,
    program: CompiledPipelineProgram,
    userPrompt: string,
  ): Promise<PipelineRuntimeResult> {
    if (!this.dependencies.createSession) {
      throw new Error('PipelineService v3 execution requires an AgentNodeSession createSession dependency.');
    }
    this.dependencies.onPipelineStart?.({
      sessionId,
      program,
      workspaceCwd: this.workspaceCwd(),
    });
    const runtime = new PipelineRuntime(
      { createSession: this.dependencies.createSession },
      {
        runIdFactory: () => sessionId,
        programs: [program],
        onEvent: event => {
          const rejected = event.type === 'cancelled' && this.v3RejectedRuns.has(event.runId);
          this.emit('status', {
            sessionId: event.runId,
            status: rejected ? 'rejected' : mapRuntimeEventToStatus(event.type),
            message: rejected ? 'Pipeline pause rejected.' : event.message ?? mapRuntimeEventToMessage(event.type, event.nodeId),
            stepId: event.nodeId,
          });
        },
      },
    );
    this.v3Runs.set(sessionId, runtime);
    return this.handleV3Result(
      sessionId,
      await runtime.start(program, { inputs: { userPrompt } }),
    );
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private handleV3Result(sessionId: string, result: PipelineRuntimeResult): PipelineRuntimeResult {
    if (result.status === 'paused') {
      this.emitV3Pause(sessionId, result.pause);
      this.publishV3Artifacts(result);
      return result;
    }
    if (result.status === 'completed') {
      this.publishV3Artifacts(result);
      this.v3Runs.delete(sessionId);
      return result;
    }
    if (result.status === 'cancelled') {
      this.v3Runs.delete(sessionId);
      this.v3RejectedRuns.delete(sessionId);
      return result;
    }
    this.v3Runs.delete(sessionId);
    this.v3RejectedRuns.delete(sessionId);
    throw new Error(result.error.message);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private publishV3Artifacts(
    result: Extract<PipelineRuntimeResult, { status: 'paused' | 'completed' }>,
  ): void {
    const publisher = this.dependencies.artifactPublisher ?? publishPipelineArtifacts;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
    publisher(this.workspaceCwd(), result.snapshot);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private emitV3Pause(sessionId: string, pause: PipelinePauseSnapshot): void {
    if (pause.type === 'approval') {
      this.emit('plan-ready', {
        sessionId,
        plan: pause.content,
        stepId: pause.nodeId,
        pauseType: pause.type,
        role: pause.nodeId,
        revised: false,
        implementerUsesSandbox: false,
      });
      this.emit('status', {
        sessionId,
        status: 'awaiting_approval',
        message: 'Pipeline paused for approval.',
        stepId: pause.nodeId,
      });
      return;
    }
    if (pause.type === 'question') {
      this.emit('plan-ready', {
        sessionId,
        plan: pause.content,
        stepId: pause.nodeId,
        pauseType: pause.type,
        role: pause.nodeId,
        revised: false,
        implementerUsesSandbox: false,
      });
    }
    this.emit('status', {
      sessionId,
      status: 'awaiting_approval',
      message: `Pipeline paused for ${pause.type}.`,
      stepId: pause.nodeId,
    });
  }

/** Valide ou résout les données de cette étape du cycle de vie ; les entrées invalides restent signalées au point d'appel. */
  private readPipelineProgram(pipelineAgentName?: string): CompiledPipelineProgram | null {
    if (pipelineAgentName) {
      const program = this.dependencies.getPipelineProgramForAgent?.(pipelineAgentName);
      if (program) {
        return program;
      }
    }
    const programs = this.dependencies.getPipelinePrograms?.() ?? [];
    if (pipelineAgentName) {
      return programs.find(program => program.title === pipelineAgentName || program.id === pipelineAgentName) ?? null;
    }
    return programs[0] ?? null;
  }
}

/** Point d'entrée mapRuntimeEventToStatus du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function mapRuntimeEventToStatus(type: string): string {
  switch (type) {
    case 'node_started':
      return 'running';
    case 'paused':
      return 'awaiting_approval';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'running';
  }
}

/** Point d'entrée mapRuntimeEventToMessage du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function mapRuntimeEventToMessage(type: string, nodeId: string | undefined): string {
  switch (type) {
    case 'node_started':
      return `Pipeline node "${nodeId ?? 'unknown'}" started.`;
    case 'node_completed':
      return `Pipeline node "${nodeId ?? 'unknown'}" completed.`;
    case 'paused':
      return 'Pipeline paused.';
    case 'completed':
      return 'Pipeline completed.';
    case 'failed':
      return 'Pipeline failed.';
    case 'cancelled':
      return 'Pipeline cancelled.';
    default:
      return 'Pipeline running.';
  }
}

/** Point d'entrée stringifyArtifactValue du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function stringifyArtifactValue(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

/** Point d'entrée stringifyServiceResult du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function stringifyServiceResult(result: PipelineRuntimeResult): string {
  if (result.status === 'paused') {
    return result.pause.content;
  }
  if (result.status === 'completed') {
    return stringifyArtifactValue(result.artifact?.value);
  }
  if (result.status === 'cancelled') {
    return '';
  }
  throw new Error(result.error.message);
}
