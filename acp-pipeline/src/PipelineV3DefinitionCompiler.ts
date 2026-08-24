import {
  compilePipelineV3Definition as compileResolvedPipelineV3Definition,
} from "./PipelineV3Compiler";
import type { PipelineCompileResult } from "./PipelineV3Types";

export { parseArtifactProducer } from "./PipelineV3Compiler";

/**
 * Point d'entrée public du compilateur. Le catalogue résout d'abord le contenu
 * de instructionsFile ; les appelants directs bénéficient aussi de la
 * normalisation du champ renommé dans l'emplacement de compatibilité.
 */
export function compilePipelineV3Definition(
  value: unknown,
  agentConfigs: Record<string, unknown> = {},
): PipelineCompileResult {
  const normalized = normalizeInstructionsFileField(value);
  const sandboxNetworkErrors = validateSandboxNodeNetworkPolicies(normalized, agentConfigs);
  if (sandboxNetworkErrors.length > 0) {
    return { errors: sandboxNetworkErrors };
  }
  return compileResolvedPipelineV3Definition(normalized, agentConfigs);
}

export function validateSandboxNodeNetworkPolicies(
  value: unknown,
  agentConfigs: Record<string, unknown>,
): string[] {
  if (!isRecord(value) || !Array.isArray(value.nodes)) {
    return [];
  }
  const policies = isRecord(value.policies) ? value.policies : {};
  const errors: string[] = [];
  value.nodes.forEach((node, index) => {
    if (!isRecord(node) || typeof node.agent !== "string") {
      return;
    }
    const agent = agentConfigs[node.agent];
    if (!isRecord(agent) || agent.transport !== "sandbox") {
      return;
    }
    const policy = typeof node.policy === "string"
      ? policies[node.policy]
      : node.policy;
    if (isRecord(policy) && policy.network !== undefined) {
      const nodeId = typeof node.id === "string" && node.id.trim() ? node.id : String(index + 1);
      errors.push(`node "${nodeId}" network policy is not supported for Docker Sandbox Runs; configure the global policy with "sbx policy".`);
    }
  });
  return errors;
}

function normalizeInstructionsFileField(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.nodes)) {
    return value;
  }
  return {
    ...value,
    nodes: value.nodes.map(node => {
      if (
        !isRecord(node)
        || typeof node.instructionsFile !== "string"
        || typeof node.promptFile === "string"
      ) {
        return node;
      }
      const { instructionsFile: _instructionsFile, ...rest } = node;
      return {
        ...rest,
        promptFile: node.instructionsFile,
      };
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
