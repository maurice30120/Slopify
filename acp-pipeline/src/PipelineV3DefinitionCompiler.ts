import {
  compilePipelineV3Definition as compileResolvedPipelineV3Definition,
} from "./PipelineV3Compiler";
import type { PipelineCompileResult } from "./PipelineV3Types";

export { parseArtifactProducer } from "./PipelineV3Compiler";

/**
 * Public compiler entrypoint. Catalog loading resolves instructionsFile content
 * first; direct callers still get the renamed field normalized into the
 * compiler's compatibility slot.
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
