import * as fs from "node:fs";
import * as path from "node:path";

import { compilePipelineV3Definition } from "./PipelineV3DefinitionCompiler";
import type { CompiledPipelineProgram } from "./PipelineV3Types";

export interface PipelineV3CatalogSource {
  filePath: string;
  definition: unknown;
}

export interface PipelineV3CatalogOptions {
  workspaceCwd: string;
  configRoot?: string;
  maxInstructionsFileBytes?: number;
  /** @deprecated Utiliser `maxInstructionsFileBytes`. */
  maxPromptFileBytes?: number;
  agentConfigs?: Record<string, unknown>;
}

export interface PipelineV3CatalogError {
  filePath: string;
  errors: string[];
}

export interface PipelineV3CatalogResult {
  programs: CompiledPipelineProgram[];
  errors: PipelineV3CatalogError[];
}

export function compilePipelineV3Catalog(
  sources: PipelineV3CatalogSource[],
  options: PipelineV3CatalogOptions,
): PipelineV3CatalogResult {
  const programs: CompiledPipelineProgram[] = [];
  const errors: PipelineV3CatalogError[] = [];
  const maxBytes = options.maxInstructionsFileBytes ?? options.maxPromptFileBytes;
  if (maxBytes === undefined) {
    return {
      programs,
      errors: sources.map(source => ({
        filePath: source.filePath,
        errors: ["maxInstructionsFileBytes must be configured."],
      })),
    };
  }

  for (const source of [...sources].sort(compareSources)) {
    const versionError = rejectUnsupportedVersion(source.definition);
    if (versionError) {
      errors.push({ filePath: source.filePath, errors: [versionError] });
      continue;
    }

    const resolved = resolvePipelineV3InstructionFiles(source.definition, {
      workspaceCwd: options.workspaceCwd,
      configRoot: options.configRoot,
      maxBytes,
      pipelineFilePath: source.filePath,
    });
    if (resolved.errors.length > 0) {
      errors.push({
        filePath: source.filePath,
        errors: resolved.errors.map(error => `node "${error.nodeId}": ${error.error}`),
      });
      continue;
    }

    const compiled = compilePipelineV3Definition(
      resolved.definition,
      options.agentConfigs ?? {},
    );
    if (!compiled.program) {
      errors.push({ filePath: source.filePath, errors: compiled.errors });
      continue;
    }
    programs.push(compiled.program);
  }

  return { programs, errors };
}

export interface PipelineV3InstructionFileResolveOptions {
  workspaceCwd: string;
  configRoot?: string;
  maxBytes: number;
  pipelineFilePath: string;
}

export interface PipelineV3InstructionFileResolveError {
  nodeId: string;
  error: string;
}

/**
 * Résout le champ public instructionsFile sans mélanger le rôle et les règles
 * avec la tâche propre au run. Le champ de compatibilité promptFile transporte
 * en interne le texte d'instructions résolu : ce n'est plus un chemin et il
 * n'est jamais concaténé avec prompt.
 *
 * L'ancien champ YAML promptFile reste accepté comme alias obsolète. S'il est
 * la seule source de prompt du nœud, son contenu reste la tâche complète. En
 * présence d'un prompt inline, le fichier devient la couche d'instructions
 * invariantes.
 */
export function resolvePipelineV3InstructionFiles(
  definition: unknown,
  options: PipelineV3InstructionFileResolveOptions,
): { definition: unknown; errors: PipelineV3InstructionFileResolveError[] } {
  if (!isRecord(definition) || !Array.isArray(definition.nodes)) {
    return { definition, errors: [] };
  }

  const errors: PipelineV3InstructionFileResolveError[] = [];
  const nodes = definition.nodes.map((node, index) => {
    if (!isRecord(node)) {
      return node;
    }

    const nodeId = typeof node.id === "string" && node.id.trim() ? node.id : String(index + 1);
    const hasInstructionsFile = typeof node.instructionsFile === "string";
    const hasLegacyPromptFile = !hasInstructionsFile && typeof node.promptFile === "string";
    const instructionsFile = hasInstructionsFile
      ? node.instructionsFile as string
      : hasLegacyPromptFile
        ? node.promptFile as string
        : undefined;
    if (!instructionsFile) {
      return node;
    }

    const hasInlineTask = typeof node.prompt === "string" && node.prompt.length > 0;
    if (hasInstructionsFile && !hasInlineTask) {
      errors.push({
        nodeId,
        error: "instructionsFile requires prompt to define the task and run data.",
      });
      return node;
    }

    const outcome = readInstructionsFile(instructionsFile, options);
    if ("error" in outcome) {
      errors.push({ nodeId, error: outcome.error });
      return node;
    }

    const {
      instructionsFile: _instructionsFile,
      promptFile: _legacyPromptFile,
      ...rest
    } = node;
    if (hasLegacyPromptFile && !hasInlineTask) {
      return {
        ...rest,
        prompt: outcome.content,
      };
    }
    return {
      ...rest,
      // Ce champ de compatibilité est consommé comme PipelineNodePrompt.instructions.
      promptFile: outcome.content,
    };
  });

  return {
    definition: { ...definition, nodes },
    errors,
  };
}

/** @deprecated Utiliser `resolvePipelineV3InstructionFiles`. */
export const resolvePipelineV3PromptFiles = resolvePipelineV3InstructionFiles;
/** @deprecated Utiliser `PipelineV3InstructionFileResolveOptions`. */
export type PipelineV3PromptFileResolveOptions = PipelineV3InstructionFileResolveOptions;
/** @deprecated Utiliser `PipelineV3InstructionFileResolveError`. */
export type PipelineV3PromptFileResolveError = PipelineV3InstructionFileResolveError;

function rejectUnsupportedVersion(definition: unknown): string | null {
  if (!isRecord(definition)) {
    return null;
  }
  if (definition.version !== undefined && definition.version !== 3) {
    return `Unsupported ACP pipeline version ${String(definition.version)}; only version 3 is supported.`;
  }
  if ("primitives" in definition || "steps" in definition) {
    return 'Unsupported ACP pipeline structure; use version 3 "nodes" instead of v2 "primitives" or "steps".';
  }
  return null;
}

function readInstructionsFile(
  relativePath: string,
  options: PipelineV3InstructionFileResolveOptions,
): { content: string } | { error: string } {
  const safePath = resolveSafePath(relativePath, options);
  if ("error" in safePath) {
    return safePath;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(safePath.absolutePath);
  } catch {
    return { error: `instructionsFile not found: ${relativePath}` };
  }

  if (!stat.isFile()) {
    return { error: `instructionsFile path is not a file: ${relativePath}` };
  }
  if (stat.size > options.maxBytes) {
    return { error: `instructionsFile exceeds max size (${options.maxBytes} bytes): ${relativePath}` };
  }

  try {
    return { content: fs.readFileSync(safePath.absolutePath, "utf8") };
  } catch (e: unknown) {
    const message = e instanceof Error && e.message ? e.message : String(e);
    return { error: `Failed to read instructionsFile: ${message}` };
  }
}

function resolveSafePath(
  relativePath: string,
  options: PipelineV3InstructionFileResolveOptions,
): { absolutePath: string } | { error: string } {
  if (path.isAbsolute(relativePath)) {
    return { error: "instructionsFile path must be relative to the pipeline YAML file." };
  }

  const normalizedRelative = path.normalize(relativePath);
  if (path.isAbsolute(normalizedRelative)) {
    return { error: "instructionsFile path must be relative." };
  }

  const configRoot = path.resolve(options.configRoot ?? options.workspaceCwd);
  const acpRoot = path.join(configRoot, ".acp");
  const pipelineDir = path.dirname(options.pipelineFilePath);
  const normalizedForPrefix = relativePath.replaceAll("\\", "/");
  const baseDir = normalizedForPrefix.startsWith(".acp/") ? configRoot : pipelineDir;
  const candidate = path.resolve(baseDir, normalizedRelative);
  const relativeToAcpRoot = path.relative(acpRoot, candidate);

  if (relativeToAcpRoot.startsWith("..") || path.isAbsolute(relativeToAcpRoot)) {
    return { error: "instructionsFile path must stay within the ACP config root." };
  }
  return { absolutePath: candidate };
}

function compareSources(a: PipelineV3CatalogSource, b: PipelineV3CatalogSource): number {
  return a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
