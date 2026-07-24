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

export interface PipelineServiceDependencies {
  getPipelinePrograms?: () => CompiledPipelineProgram[];
  getPipelineProgramForAgent?: (agentName: string) => CompiledPipelineProgram | null;
  getAgentConfigs?: () => Record<string, unknown>;
  createSession?: AgentNodeSessionFactory;
  onPipelineStart?: (input: { sessionId: string; program: CompiledPipelineProgram; workspaceCwd: string }) => void;
  isAgentSandcastle?: (agentName: string, agentConfigs: Record<string, unknown>) => boolean;
  isRunAbortedError?: (error: unknown) => boolean;
  artifactPublisher?: PipelineArtifactPublisher;
}

export class PipelineService extends EventEmitter {
  private readonly v3Runs = new Map<string, PipelineRuntime>();
  private readonly v3RejectedRuns = new Set<string>();

  constructor(
    private readonly workspaceCwd: () => string,
    private readonly dependencies: PipelineServiceDependencies = {},
  ) {
    super();
  }

  async createPlan(sessionId: string, userPrompt: string, pipelineAgentName?: string): Promise<string> {
    return stringifyServiceResult(await this.startPipeline(sessionId, userPrompt, pipelineAgentName));
  }

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

  async approvePlan(sessionId: string, approvedPlan: string): Promise<string> {
    return stringifyServiceResult(await this.resumeCurrentPause(sessionId, "approve", approvedPlan.trim()));
  }

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

  async getPendingPause(sessionId: string): Promise<PipelinePauseSnapshot | null> {
    const runtime = this.v3Runs.get(sessionId);
    if (!runtime) {
      return null;
    }
    const snapshot = await runtime.inspect(sessionId);
    return snapshot?.pendingPause ?? null;
  }

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

  cancel(sessionId: string): void {
    const runtime = this.v3Runs.get(sessionId);
    if (runtime) {
      void runtime.cancel(sessionId);
      this.v3Runs.delete(sessionId);
      return;
    }
  }

  async dispose(): Promise<void> {
    for (const [sessionId, runtime] of this.v3Runs.entries()) {
      await runtime.cancel(sessionId);
    }
    this.v3Runs.clear();
    this.removeAllListeners();
  }

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

  private publishV3Artifacts(
    result: Extract<PipelineRuntimeResult, { status: 'paused' | 'completed' }>,
  ): void {
    const publisher = this.dependencies.artifactPublisher ?? publishPipelineArtifacts;
    publisher(this.workspaceCwd(), result.snapshot);
  }

  private emitV3Pause(sessionId: string, pause: PipelinePauseSnapshot): void {
    if (pause.type === 'approval') {
      this.emit('plan-ready', {
        sessionId,
        plan: pause.content,
        stepId: pause.nodeId,
        pauseType: pause.type,
        role: pause.nodeId,
        revised: false,
        implementerUsesSandcastle: false,
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
        implementerUsesSandcastle: false,
      });
    }
    this.emit('status', {
      sessionId,
      status: 'awaiting_approval',
      message: `Pipeline paused for ${pause.type}.`,
      stepId: pause.nodeId,
    });
  }

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

function stringifyArtifactValue(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

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
