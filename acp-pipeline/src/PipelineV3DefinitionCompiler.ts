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
  return compileResolvedPipelineV3Definition(
    normalizeInstructionsFileField(value),
    agentConfigs,
  );
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
