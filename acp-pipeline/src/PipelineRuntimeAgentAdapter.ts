import type { SessionNotification } from "@agentclientprotocol/sdk";

import {
  READ_ONLY_PIPELINE_POLICY,
  mapPolicyToLegacyPermissions,
  mapPolicyToLegacySideEffects,
} from "./PipelinePolicy";
import { PipelineIntegrationConflictError, PipelineSandboxResumeDivergenceError } from "./PipelineAgentRunner";
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
  PipelineSandboxRunSnapshot,
} from "./PipelineV3Types";
import { resolvePipelineStepText } from "./PipelineStepCompletion";

/** Contrat fonctionnel de PipelineRuntimeAgentAdapterOptions dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
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
/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
  constructor(private readonly options: PipelineRuntimeAgentAdapterOptions) {}

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async createSession(input: AgentNodeSessionFactoryInput): Promise<AgentNodeSession> {
    return new PipelineRuntimeAgentNodeSession(input, this.options);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async finalizePipelineChangeSet(
    input: PipelineChangeSetFinalizationInput,
  ): Promise<PipelineChangeSetFinalizationResult | undefined> {
    return this.options.runAgent.finalizePipelineChangeSet?.(input);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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

/** Composant PipelineRuntimeAgentNodeSession qui coordonne une étape observable du cycle de vie du pipeline et en préserve les invariants. */
class PipelineRuntimeAgentNodeSession implements AgentNodeSession {
  readonly runId: string;
  readonly nodeId: string;
  private closed = false;
  private controller: AbortController;

/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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
      let checkpointState: PipelineSandboxRunSnapshot | undefined;
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
        onSandboxRunState: async state => {
          if (state.checkpoint) checkpointState = state;
          await input.onSandboxRunState?.(state);
        },
        resumeSandboxRun: input.resumeSandboxRun,
        dependencyCheckpoints: input.dependencyCheckpoints,
      });
      const text = resolvePipelineStepText(result);
      let value: unknown = text;
      if (node.output.format === "json") {
        try {
          value = decodeJsonOutput(text);
        } catch {
          const template = JSON_OUTPUT_TEMPLATES[node.output.type];
          if (!template) return invalidJsonOutput(node.id);
          const repairPrompt = `Repair only the missing JSON delivery artifact. Do not implement, modify files, add dependencies, run tests or commit. Read the existing checkpoint files if needed. Return the actual JSON object itself, without prose. Never invent validations or commits. Required shape (replace examples with actual evidence): ${JSON.stringify(template)}\nOriginal task:\n${input.prompt}\nOriginal response:\n${text}`;
          const dependencyCheckpoints = checkpointState?.checkpoint
            ? [{ runId: checkpointState.runId, nodeId: checkpointState.nodeId, attempt: checkpointState.attempt, sandboxName: checkpointState.sandboxName, baseCommit: checkpointState.baseCommit, checkpoint: checkpointState.checkpoint }]
            : input.dependencyCheckpoints;
          const repaired = await this.options.runAgent({
            runId: input.runId, nodeId: `${node.id}-output-repair`, attempt: input.attempt,
            workspaceCwd: this.options.workspaceCwd(), agentName: node.agent,
            promptText: repairPrompt, prompt: { skills: [], instructions: "Deliver one JSON object only. This is a read-only formatting repair, not implementation.", task: repairPrompt, context: Object.values(input.inputs) },
            signal: this.controller.signal,
            sideEffects: "none", permissions: mapPolicyToLegacyPermissions(READ_ONLY_PIPELINE_POLICY), promotion: "discard", skills: [],
            dependencyCheckpoints,
            onSessionUpdate: update => this.options.onSessionUpdate?.(input.runId, node, update),
            onStatus: update => this.options.onStatus?.(input.runId, node, update),
          });
          try { value = decodeJsonOutput(resolvePipelineStepText(repaired)); }
          catch { return invalidJsonOutput(node.id); }
        }
      }
      return {
        artifact: {
          name: node.output.name,
          type: node.output.type,
          format: node.output.format,
          value,
        },
      };
    } catch (e: unknown) {
      if (e instanceof PipelineSandboxResumeDivergenceError || e instanceof PipelineIntegrationConflictError) throw e;
      return {
        code: "agent_failed",
        message: e instanceof Error && e.message ? e.message : String(e),
        retryable: false,
      };
    }
  }

/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  async cancel(): Promise<void> {
    this.controller.abort();
  }

/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  async close(): Promise<void> {
    this.closed = true;
    this.controller.abort();
  }
}


const JSON_OUTPUT_TEMPLATES: Record<string, unknown> = {
  "acp.ticket-graph/v1": { contract: "acp.ticket-graph/v1", documentation: "`actual issues directory/`", tickets: [{ id: "T01", title: "actual title", scope: ["actual scope"], needs: [], validation: ["actual planned validation"] }] },
  "acp.implementation-result/v1": { contract: "acp.implementation-result/v1", ticketId: "actual ticket ID", branch: "actual branch", commits: ["actual commit hash"], summary: "actual changes", validations: ["actual commands and results"] },
  "acp.verification-report/v1": { contract: "acp.verification-report/v1", verdict: "failed", categories: [{ name: "actual category", required: true, status: "failed", details: "actual evidence; use passed only when verified" }] },
};

/** Point d'entrée decodeJsonOutput du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function decodeJsonOutput(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```/g)?.length === 2
    ? trimmed.match(/(?:^|\n)```(?:json)?[ \t]*\n([\s\S]*?)\n```(?:\n|$)/i)
    : null;
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

/** Point d'entrée invalidJsonOutput du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function invalidJsonOutput(nodeId: string) {
  return { code: "invalid_json_output", message: `Agent output for node "${nodeId}" is not valid JSON after at most one read-only formatting repair.`, retryable: false };
}
