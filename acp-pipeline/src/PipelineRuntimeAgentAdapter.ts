import type { SessionNotification } from "@agentclientprotocol/sdk";

import {
  mapPolicyToLegacyPermissions,
  mapPolicyToLegacySideEffects,
} from "./PipelinePolicy";
import type {
  PipelineAgentRunner,
  PipelineChangeSetFinalizationInput,
  PipelineChangeSetFinalizationResult,
  PipelineStepStatusUpdate,
} from "./PipelineAgentRunner";
import type {
  AgentNodeSession,
  AgentNodeSessionFactory,
  AgentNodeSessionFactoryInput,
  CompiledPipelineNode,
  PipelineNodeExecutionInput,
  PipelineNodeExecutionResult,
  PipelineRuntimeAdapter,
} from "./PipelineV3Types";
import { resolvePipelineStepText } from "./PipelineStepCompletion";

export interface PipelineRuntimeAgentAdapterOptions {
  workspaceCwd: () => string;
  runAgent: PipelineAgentRunner;
  onSessionUpdate?: (runId: string, node: CompiledPipelineNode, update: SessionNotification) => void;
  onStatus?: (runId: string, node: CompiledPipelineNode, update: PipelineStepStatusUpdate) => void;
}

/**
 * Isole le runtime de DAG du contrat historique PipelineAgentRunner. Cette
 * couche est le seul endroit où un prompt structuré et une politique normalisée
 * sont rabattus vers les champs de compatibilité attendus par les runners tiers.
 */
export class PipelineRuntimeAgentAdapter implements PipelineRuntimeAdapter {
  constructor(private readonly options: PipelineRuntimeAgentAdapterOptions) {}

  async createSession(input: AgentNodeSessionFactoryInput): Promise<AgentNodeSession> {
    return new PipelineRuntimeAgentNodeSession(input, this.options);
  }

  async execute(input: PipelineNodeExecutionInput): Promise<PipelineNodeExecutionResult> {
    const session = await this.createSession({
      runId: input.runId,
      node: input.node,
      signal: input.signal,
    });
    try {
      return await session.send(input);
    } finally {
      await session.close();
    }
  }

  async finalizePipelineChangeSet(
    input: PipelineChangeSetFinalizationInput,
  ): Promise<PipelineChangeSetFinalizationResult | undefined> {
    return this.options.runAgent.finalizePipelineChangeSet?.(input);
  }

  asSessionFactory(): AgentNodeSessionFactory {
    // La factory est une fonction enrichie d'un hook de finalisation. Conserver
    // ce hook sur l'objet callable permet aux hôtes historiques de participer à
    // la Promotion globale sans modifier la signature AgentNodeSessionFactory.
    const factory = (input => this.createSession(input)) as AgentNodeSessionFactory & {
      finalizePipelineChangeSet?: PipelineRuntimeAgentAdapter["finalizePipelineChangeSet"];
    };
    factory.finalizePipelineChangeSet = input => this.finalizePipelineChangeSet(input);
    return factory;
  }
}

class PipelineRuntimeAgentNodeSession implements AgentNodeSession {
  readonly runId: string;
  readonly nodeId: string;
  private closed = false;
  private controller: AbortController;

  constructor(
    input: AgentNodeSessionFactoryInput,
    private readonly options: PipelineRuntimeAgentAdapterOptions,
  ) {
    this.runId = input.runId;
    this.nodeId = input.node.id;
    this.controller = new AbortController();
    if (input.signal.aborted) {
      this.controller.abort();
    } else {
      input.signal.addEventListener("abort", () => this.controller.abort(), { once: true });
    }
  }

  async send(input: PipelineNodeExecutionInput): Promise<PipelineNodeExecutionResult> {
    const node = input.node;
    if (this.closed) {
      return {
        code: "agent_session_closed",
        message: `AgentNodeSession for node "${this.nodeId}" is closed.`,
      };
    }
    if (!node.agent) {
      return {
        code: "missing_agent",
        message: `Node "${node.id}" does not declare an ACP agent.`,
      };
    }
    if (!node.output) {
      return {
        code: "missing_output",
        message: `Node "${node.id}" does not declare an output artifact.`,
      };
    }

    try {
      const result = await this.options.runAgent({
        runId: input.runId,
        nodeId: node.id,
        attempt: input.attempt,
        workspaceCwd: this.options.workspaceCwd(),
        agentName: node.agent,
        promptText: input.prompt,
        prompt: {
          skills: [...node.skills],
          // Le catalogue résout instructionsFile dans ce champ de compatibilité
          // avant la compilation afin de ne pas modifier le contrat du runtime.
          instructions: node.promptFile,
          task: input.prompt,
          context: Object.values(input.inputs),
        },
        signal: this.controller.signal,
        onSessionUpdate: update => this.options.onSessionUpdate?.(input.runId, node, update),
        onStatus: update => this.options.onStatus?.(input.runId, node, update),
        sideEffects: mapPolicyToLegacySideEffects(node.policy),
        permissions: mapPolicyToLegacyPermissions(node.policy),
        promotion: node.policy.promotion,
        skills: [...node.skills],
      });
      return {
        artifact: {
          name: node.output.name,
          type: node.output.type,
          format: node.output.format,
          value: resolvePipelineStepText(result),
        },
      };
    } catch (e: unknown) {
      return {
        code: "agent_failed",
        message: e instanceof Error && e.message ? e.message : String(e),
        retryable: false,
      };
    }
  }

  async cancel(): Promise<void> {
    this.controller.abort();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.controller.abort();
  }
}
