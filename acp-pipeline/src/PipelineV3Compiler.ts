import { normalizePipelinePolicy, type NormalizedPromotionPolicy } from "./PipelinePolicy";
import { getPipelineInterviewProtocol } from "./PipelineInterviewProtocol";
import type {
  CompiledPipelineNode,
  CompiledPipelineProgram,
  PipelineInteractionDefinition,
  PipelineWorkspaceHandoffDefinition,
  PipelineCompileResult,
  PipelineNodeInputDefinition,
  PipelineRetryDefinition,
} from "./PipelineV3Types";
import type { PipelinePolicyReference } from "./PipelineV3Types";

type RawRecord = Record<string, unknown>;

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const DEFAULT_RETRY: PipelineRetryDefinition = Object.freeze({ maxAttempts: 1, backoffMs: 0 });
const DEFAULT_POLICY: PipelinePolicyReference = Object.freeze({
  filesystem: "read-only",
  terminal: "none",
  network: "disabled",
  promotion: "discard",
});

/** Point d'entrée compilePipelineV3Definition du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
export function compilePipelineV3Definition(
  value: unknown,
  agentConfigs: Record<string, unknown> = {},
): PipelineCompileResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { errors: ["Pipeline YAML must be an object."] };
  }
  if (value.version !== 3) {
    errors.push("version must be 3.");
  }

  const id = readRequiredId(value, "id", "pipeline", errors);
  const title = readRequiredString(value, "title", "pipeline", errors);
  const promotion = readPipelinePromotion(value.promotion, errors);
  const maxConcurrency = readPipelineMaxConcurrency(value.maxConcurrency, errors);
  const rawPolicies = readPolicies(value.policies, errors);
  const nodes = readNodes(value.nodes, rawPolicies, agentConfigs, errors);

/** Valide ou résout les données de cette étape du cycle de vie ; les entrées invalides restent signalées au point d'appel. */
  validateGraph(nodes, errors);
/** Valide ou résout les données de cette étape du cycle de vie ; les entrées invalides restent signalées au point d'appel. */
  validateInputs(nodes, errors);

  if (errors.length > 0 || !id || !title) {
    return { errors };
  }

  return {
    program: createCompiledProgram({
      version: 3, id, title, promotion,
      ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
    }, nodes),
    errors: [],
  };
}

/** Point d'entrée appendCompiledPipelineNodes du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
export function appendCompiledPipelineNodes(
  program: CompiledPipelineProgram,
  candidates: readonly CompiledPipelineNode[],
): CompiledPipelineProgram {
  const appended = candidates.filter(node => !program.nodesById.has(node.id));
  return appended.length === 0
    ? program
    : createCompiledProgram(program, [...program.nodes, ...appended]);
}

/**
 * Lie l'agent choisi par l'hôte à chaque nœud agent d'un pipeline.
 * La sélection de l'agent reste volontairement hors de la définition du pipeline afin que
 * le même pipeline puisse fonctionner avec différentes configurations ACP ou Sandbox.
 */
export function bindPipelineAgent(
  program: CompiledPipelineProgram,
  agentName: string,
): CompiledPipelineProgram {
  const normalized = agentName.trim();
  if (!normalized) {
    throw new Error("Pipeline agent name must not be empty.");
  }
  const nodes = program.nodes.map(node => node.kind === "agent"
    ? { ...node, agent: normalized }
    : node);
  return nodes.every((node, index) => node === program.nodes[index])
    ? program
    : createCompiledProgram(program, nodes);
}

/** Point d'entrée createCompiledProgram du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function createCompiledProgram(
  metadata: Pick<CompiledPipelineProgram, "version" | "id" | "title" | "promotion" | "maxConcurrency">,
  nodes: readonly CompiledPipelineNode[],
): CompiledPipelineProgram {
  const nodesById = new Map(nodes.map(node => [node.id, node] as const));
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    dependents.set(node.id, []);
  }
  for (const node of nodes) {
    for (const dependency of node.needs) {
      dependents.get(dependency)?.push(node.id);
    }
  }
  for (const value of dependents.values()) {
    value.sort();
  }

  const program: CompiledPipelineProgram = deepFreeze({
    ...metadata,
    nodes,
    nodesById: new ImmutableMap(nodesById),
    dependentsById: new ImmutableMap(dependents),
    rootNodeIds: nodes.filter(node => node.needs.length === 0).map(node => node.id).sort(),
    terminalNodeIds: nodes.filter(node => (dependents.get(node.id) ?? []).length === 0).map(node => node.id).sort(),
  });
  return program;
}

/** Point d'entrée readPipelinePromotion du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function readPipelinePromotion(value: unknown, errors: string[]): NormalizedPromotionPolicy {
  if (value === undefined) return "discard";
  if (value === "discard" || value === "ask" || value === "auto-apply" || value === "auto-reject") {
    return value;
  }
  errors.push('pipeline promotion must be "discard", "ask", "auto-apply", or "auto-reject".');
  return "discard";
}

/** Point d'entrée readPipelineMaxConcurrency du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function readPipelineMaxConcurrency(value: unknown, errors: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    errors.push("pipeline maxConcurrency must be an integer greater than or equal to 1.");
    return undefined;
  }
  return value;
}

/** Point d'entrée readNodes du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function readNodes(
  value: unknown,
  policies: Record<string, PipelinePolicyReference>,
  agentConfigs: Record<string, unknown>,
  errors: string[],
): CompiledPipelineNode[] {
  if (!Array.isArray(value)) {
    errors.push("nodes must be an array.");
    return [];
  }

  const nodes: CompiledPipelineNode[] = [];
  const seen = new Set<string>();
  for (const [index, nodeValue] of value.entries()) {
    const label = `node ${index + 1}`;
    if (!isRecord(nodeValue)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    const id = readRequiredId(nodeValue, "id", label, errors);
    if (id && seen.has(id)) {
      errors.push(`node id "${id}" is duplicated.`);
    }
    if (id) {
      seen.add(id);
    }

    if (nodeValue.type !== undefined && nodeValue.type !== "agent" && nodeValue.type !== "pause") {
      errors.push(`${id ? `node "${id}"` : label} type must be "agent" or "pause".`);
      continue;
    }
    const kind = nodeValue.type === "pause" ? "pause" : "agent";
    const needs = readStringArray(nodeValue.needs, "needs", id ? `node "${id}"` : label, errors);
    const inputs = readInputs(nodeValue.inputs, id ? `node "${id}"` : label, errors);
    const retry = readRetry(nodeValue.retry, id ? `node "${id}"` : label, errors);
    const policy = resolvePolicy(nodeValue.policy, policies, id ? `node "${id}"` : label, errors);
    const skills = readStringArray(nodeValue.skills, "skills", id ? `node "${id}"` : label, errors);

    if (kind === "pause") {
      if (nodeValue.interaction !== undefined) {
        errors.push(`${id ? `node "${id}"` : label} interaction is only supported on agent nodes.`);
      }
      const pause = nodeValue.pause;
      if (!isPauseType(pause)) {
        errors.push(`${id ? `node "${id}"` : label} pause must be "approval", "question", or "promotion".`);
      }
      const format = nodeValue.format ?? "markdown";
      if (format !== "text" && format !== "markdown" && format !== "json" && format !== "proposed-plan") {
        errors.push(`${id ? `node "${id}"` : label} format must be "text", "markdown", "json", or "proposed-plan".`);
      }
      const content = readRequiredString(nodeValue, "content", id ? `node "${id}"` : label, errors);
      const output = readOutput(nodeValue.output, id ? `node "${id}"` : label, errors, false);
      const handoff = readWorkspaceHandoff(nodeValue.handoff, id ? `node "${id}"` : label, errors);
      const workspaceGuard = readWorkspaceGuard(nodeValue.workspaceGuard, id ? `node "${id}"` : label, errors);
      if (id && isPauseType(pause) && content && isValidPauseFormat(format)) {
        nodes.push(deepFreeze({
          id,
          kind,
          needs,
          inputs,
          output,
          retry: DEFAULT_RETRY,
          pause,
          pauseContent: content,
          pauseFormat: format,
          handoff,
          workspaceGuard,
          policy: normalizePipelinePolicy(policy),
          skills: [],
        }));
      }
      continue;
    }

    const agent = readOptionalString(nodeValue.agent, "agent", id ? `node "${id}"` : label, errors);
    if (agent && !agentConfigs[agent]) {
      errors.push(`node "${id}" references missing ACP agent "${agent}".`);
    }
    const output = readOutput(nodeValue.output, id ? `node "${id}"` : label, errors, true);
    const interaction = readInteraction(nodeValue.interaction, id ? `node "${id}"` : label, errors);
    const prompt = readOptionalString(nodeValue.prompt, "prompt", id ? `node "${id}"` : label, errors);
    const promptFile = readOptionalString(nodeValue.promptFile, "promptFile", id ? `node "${id}"` : label, errors);
    if (!prompt && !promptFile) {
      errors.push(`${id ? `node "${id}"` : label} must define either prompt or promptFile.`);
    }
    if (id && output && (prompt || promptFile)) {
      nodes.push(deepFreeze({
        id,
        kind,
        agent,
        prompt,
        promptFile,
        skills,
        needs,
        inputs,
        output,
        interaction,
        retry,
        policy: normalizePipelinePolicy(policy),
      }));
    }
  }
  return nodes;
}

/** Point d'entrée readWorkspaceHandoff du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function readWorkspaceHandoff(
  value: unknown,
  label: string,
  errors: string[],
): PipelineWorkspaceHandoffDefinition | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    errors.push(`${label} handoff must be an object.`);
    return undefined;
  }
  if (value.kind !== "workspace-files") {
    errors.push(`${label} handoff.kind must be "workspace-files".`);
  }
  const minimumReferences = value.minimumReferences;
  if (
    minimumReferences !== undefined
    && (typeof minimumReferences !== "number" || !Number.isInteger(minimumReferences) || minimumReferences < 1)
  ) {
    errors.push(`${label} handoff.minimumReferences must be an integer greater than or equal to 1.`);
  }
  if (value.layout !== undefined && value.layout !== "delivery") {
    errors.push(`${label} handoff.layout must be "delivery" when provided.`);
  }
  if (
    value.kind !== "workspace-files"
    || (minimumReferences !== undefined
      && (typeof minimumReferences !== "number" || !Number.isInteger(minimumReferences) || minimumReferences < 1))
    || (value.layout !== undefined && value.layout !== "delivery")
  ) {
    return undefined;
  }
  return {
    kind: "workspace-files",
    ...(minimumReferences === undefined ? {} : { minimumReferences }),
    ...(value.layout === undefined ? {} : { layout: value.layout }),
  };
}

/** Point d'entrée readWorkspaceGuard du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function readWorkspaceGuard(value: unknown, label: string, errors: string[]): "documentation-only" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== "documentation-only") {
    errors.push(`${label} workspaceGuard must be "documentation-only" when provided.`);
    return undefined;
  }
  return value;
}

/** Point d'entrée readInteraction du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function readInteraction(value: unknown, label: string, errors: string[]): PipelineInteractionDefinition | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    errors.push(`${label} interaction must be an object.`);
    return undefined;
  }
  const protocol = readRequiredString(value, "protocol", `${label} interaction`, errors);
  if (protocol && !getPipelineInterviewProtocol(protocol)) {
    errors.push(`${label} interaction.protocol "${protocol}" is not registered.`);
  }
  const repairAttempts = value.repairAttempts ?? 1;
  if (typeof repairAttempts !== "number" || !Number.isInteger(repairAttempts) || repairAttempts < 0) {
    errors.push(`${label} interaction.repairAttempts must be an integer greater than or equal to 0.`);
  }
  if (!protocol || !getPipelineInterviewProtocol(protocol) || typeof repairAttempts !== "number" || !Number.isInteger(repairAttempts) || repairAttempts < 0) {
    return undefined;
  }
  return { protocol, repairAttempts };
}

/** Point d'entrée validateGraph du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function validateGraph(nodes: CompiledPipelineNode[], errors: string[]): void {
  const ids = new Set(nodes.map(node => node.id));
  for (const node of nodes) {
    for (const dependency of node.needs) {
      if (!ids.has(dependency)) {
        errors.push(`node "${node.id}" needs unknown node "${dependency}".`);
      }
      if (dependency === node.id) {
        errors.push(`node "${node.id}" cannot depend on itself.`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(nodes.map(node => [node.id, node] as const));
  const visit = (nodeId: string, path: string[]): void => {
    if (visited.has(nodeId)) {
      return;
    }
    if (visiting.has(nodeId)) {
      errors.push(`cycle detected: ${path.concat(nodeId).join(" -> ")}.`);
      return;
    }
    visiting.add(nodeId);
    for (const dependency of byId.get(nodeId)?.needs ?? []) {
      if (byId.has(dependency)) {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
        visit(dependency, path.concat(nodeId));
      }
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of nodes) {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
    visit(node.id, []);
  }

  if (nodes.length > 0 && nodes.every(node => node.needs.length > 0)) {
    errors.push("pipeline must have at least one root node.");
  }
}

/** Point d'entrée validateInputs du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function validateInputs(nodes: CompiledPipelineNode[], errors: string[]): void {
  const byId = new Map(nodes.map(node => [node.id, node] as const));
  for (const node of nodes) {
    const ancestors = collectAncestors(node, byId);
    for (const input of node.inputs) {
      const producerId = parseArtifactProducer(input.from);
      if (!producerId) {
        errors.push(`node "${node.id}" input "${input.name}" must reference "<node>.<artifact>".`);
        continue;
      }
      const producer = byId.get(producerId.nodeId);
      if (!producer?.output || producer.output.name !== producerId.artifactName) {
        errors.push(`node "${node.id}" input "${input.name}" references unknown artifact "${input.from}".`);
        continue;
      }
      if (!ancestors.has(producer.id)) {
        errors.push(`node "${node.id}" input "${input.name}" references producer "${producer.id}" outside its dependencies.`);
      }
      if (input.type && input.type !== producer.output.type) {
        errors.push(`node "${node.id}" input "${input.name}" expects type "${input.type}" but "${input.from}" is "${producer.output.type}".`);
      }
      if (input.format && input.format !== producer.output.format) {
        errors.push(`node "${node.id}" input "${input.name}" expects format "${input.format}" but "${input.from}" is "${producer.output.format}".`);
      }
    }
  }
}

/** Point d'entrée collectAncestors du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function collectAncestors(node: CompiledPipelineNode, byId: Map<string, CompiledPipelineNode>): Set<string> {
  const result = new Set<string>();
  const stack = [...node.needs];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (result.has(next)) {
      continue;
    }
    result.add(next);
    stack.push(...(byId.get(next)?.needs ?? []));
  }
  return result;
}

/** Point d'entrée parseArtifactProducer du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
export function parseArtifactProducer(reference: string): { nodeId: string; artifactName: string } | null {
  const parts = reference.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return { nodeId: parts[0], artifactName: parts[1] };
}

/** Point d'entrée readOutput du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function readOutput(value: unknown, label: string, errors: string[], required: boolean) {
  if (value === undefined && !required) {
    return undefined;
  }
  if (!isRecord(value)) {
    errors.push(`${label} output must be an object.`);
    return undefined;
  }
  const name = readRequiredId(value, "name", `${label} output`, errors);
  const type = readRequiredString(value, "type", `${label} output`, errors);
  const format = value.format;
  if (format !== "text" && format !== "markdown" && format !== "json") {
    errors.push(`${label} output format must be "text", "markdown", or "json".`);
  }
  return name && type && isArtifactFormat(format) ? { name, type, format } : undefined;
}

/** Point d'entrée readInputs du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function readInputs(value: unknown, label: string, errors: string[]): PipelineNodeInputDefinition[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    errors.push(`${label} inputs must be an array.`);
    return [];
  }
  const inputs: PipelineNodeInputDefinition[] = [];
  const names = new Set<string>();
  for (const [index, inputValue] of value.entries()) {
    const inputLabel = `${label} input ${index + 1}`;
    if (!isRecord(inputValue)) {
      errors.push(`${inputLabel} must be an object.`);
      continue;
    }
    const name = readRequiredId(inputValue, "name", inputLabel, errors);
    if (name && names.has(name)) {
      errors.push(`${label} input "${name}" is duplicated.`);
    }
    if (name) {
      names.add(name);
    }
    const from = readRequiredString(inputValue, "from", inputLabel, errors);
    const type = readOptionalString(inputValue.type, "type", inputLabel, errors);
    const format = inputValue.format;
    if (format !== undefined && !isArtifactFormat(format)) {
      errors.push(`${inputLabel} format must be "text", "markdown", or "json".`);
    }
    if (name && from) {
      inputs.push({ name, from, type, format: isArtifactFormat(format) ? format : undefined });
    }
  }
  return inputs;
}

/** Point d'entrée readRetry du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function readRetry(value: unknown, label: string, errors: string[]): PipelineRetryDefinition {
  if (value === undefined) {
    return DEFAULT_RETRY;
  }
  if (!isRecord(value)) {
    errors.push(`${label} retry must be an object.`);
    return DEFAULT_RETRY;
  }
  const maxAttempts = value.maxAttempts;
  const backoffMs = value.backoffMs ?? 0;
  if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    errors.push(`${label} retry.maxAttempts must be an integer from 1 to 10.`);
  }
  if (typeof backoffMs !== "number" || !Number.isInteger(backoffMs) || backoffMs < 0 || backoffMs > 60_000) {
    errors.push(`${label} retry.backoffMs must be an integer from 0 to 60000.`);
  }
  return Number.isInteger(maxAttempts) && typeof maxAttempts === "number" && maxAttempts >= 1
    && Number.isInteger(backoffMs) && typeof backoffMs === "number" && backoffMs >= 0
    ? { maxAttempts, backoffMs }
    : DEFAULT_RETRY;
}

/** Point d'entrée readPolicies du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function readPolicies(value: unknown, errors: string[]): Record<string, PipelinePolicyReference> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    errors.push("policies must be an object.");
    return {};
  }
  const policies: Record<string, PipelinePolicyReference> = {};
  for (const [name, policy] of Object.entries(value)) {
    if (!ID_RE.test(name)) {
      errors.push(`policy id "${name}" is invalid.`);
      continue;
    }
    if (!isRecord(policy)) {
      errors.push(`policy "${name}" must be an object.`);
      continue;
    }
    policies[name] = normalizePolicy(policy, `policy "${name}"`, errors);
  }
  return policies;
}

/** Point d'entrée resolvePolicy du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function resolvePolicy(
  value: unknown,
  policies: Record<string, PipelinePolicyReference>,
  label: string,
  errors: string[],
): PipelinePolicyReference {
  if (typeof value === "string") {
    const policy = policies[value];
    if (!policy) {
      errors.push(`${label} references unknown policy "${value}".`);
      return DEFAULT_POLICY;
    }
    return policy;
  }
  if (value === undefined) {
    return DEFAULT_POLICY;
  }
  if (!isRecord(value)) {
    errors.push(`${label} policy must be a string or object.`);
    return DEFAULT_POLICY;
  }
  return normalizePolicy(value, `${label} policy`, errors);
}

/** Point d'entrée normalizePolicy du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function normalizePolicy(value: RawRecord, label: string, errors: string[]): PipelinePolicyReference {
  const filesystem = value.filesystem ?? DEFAULT_POLICY.filesystem;
  const terminal = value.terminal ?? DEFAULT_POLICY.terminal;
  const network = value.network ?? DEFAULT_POLICY.network;
  const promotion = value.promotion ?? DEFAULT_POLICY.promotion;
  if (filesystem !== "read-only" && filesystem !== "workspace-write") {
    errors.push(`${label} filesystem must be "read-only" or "workspace-write".`);
  }
  if (terminal !== "none" && terminal !== "read-only" && terminal !== "workspace-write") {
    errors.push(`${label} terminal must be "none", "read-only", or "workspace-write".`);
  }
  if (network !== "disabled" && network !== "enabled") {
    errors.push(`${label} network must be "disabled" or "enabled".`);
  }
  if (promotion !== "discard" && promotion !== "ask" && promotion !== "auto-apply" && promotion !== "auto-reject") {
    errors.push(`${label} promotion must be "discard", "ask", "auto-apply", or "auto-reject".`);
  }
  return { filesystem, terminal, network, promotion } as PipelinePolicyReference;
}

/** Point d'entrée readRequiredString du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function readRequiredString(value: RawRecord, key: string, label: string, errors: string[]): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim() === "") {
    errors.push(`${label} ${key} must be a non-empty string.`);
    return "";
  }
  return field.trim();
}

/** Point d'entrée readRequiredId du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function readRequiredId(value: RawRecord, key: string, label: string, errors: string[]): string {
  const id = readRequiredString(value, key, label, errors);
  if (id && !ID_RE.test(id)) {
    errors.push(`${label} ${key} "${id}" is invalid.`);
  }
  return id;
}

/** Point d'entrée readOptionalString du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function readOptionalString(value: unknown, key: string, label: string, errors: string[]): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    errors.push(`${label} ${key} must be a string.`);
    return undefined;
  }
  return value;
}

/** Point d'entrée readStringArray du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function readStringArray(value: unknown, key: string, label: string, errors: string[]): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.trim() === "")) {
    errors.push(`${label} ${key} must be an array of non-empty strings.`);
    return [];
  }
  return [...value];
}

/** Point d'entrée isRecord du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Point d'entrée isArtifactFormat du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function isArtifactFormat(value: unknown): value is "text" | "markdown" | "json" {
  return value === "text" || value === "markdown" || value === "json";
}

/** Point d'entrée isValidPauseFormat du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function isValidPauseFormat(value: unknown): value is "text" | "markdown" | "json" | "proposed-plan" {
  return value === "text" || value === "markdown" || value === "json" || value === "proposed-plan";
}

/** Point d'entrée isPauseType du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function isPauseType(value: unknown): value is "approval" | "question" | "promotion" {
  return value === "approval" || value === "question" || value === "promotion";
}

/** Point d'entrée deepFreeze du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function deepFreeze<T>(value: T): T {
  if (value instanceof Map) {
    for (const [key, mapValue] of value.entries()) {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
      deepFreeze(key);
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
      deepFreeze(mapValue);
    }
    return Object.freeze(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
      deepFreeze(item);
    }
    return Object.freeze(value) as T;
  }
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
      deepFreeze(nested);
    }
    return Object.freeze(value);
  }
  return value;
}

/** Composant ImmutableMap qui coordonne une étape observable du cycle de vie du pipeline et en préserve les invariants. */
class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  private readonly inner: ReadonlyMap<K, V>;

/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
  constructor(values: ReadonlyMap<K, V>) {
    this.inner = new Map(values);
    Object.freeze(this);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  get size(): number {
    return this.inner.size;
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  get(key: K): V | undefined {
    return this.inner.get(key);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  has(key: K): boolean {
    return this.inner.has(key);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.inner.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  entries(): MapIterator<[K, V]> {
    return this.inner.entries();
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  keys(): MapIterator<K> {
    return this.inner.keys();
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  values(): MapIterator<V> {
    return this.inner.values();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
}
