import { validateMultiAgentArtifact, type TicketGraphArtifact } from "./MultiAgentArtifacts";

export const EXECUTION_PLAN_CONTRACT = "acp.execution-plan/v1" as const;
export const FINAL_REVIEW_NODE_ID = "final-review" as const;

export interface ExecutionPlanNode {
  readonly id: string;
  readonly kind: "implementation";
  readonly ticket: TicketGraphArtifact["tickets"][number];
  readonly needs: readonly string[];
}

export interface ExecutionPlan {
  readonly contract: typeof EXECUTION_PLAN_CONTRACT;
  readonly nodes: readonly ExecutionPlanNode[];
  readonly terminalNodeIds: readonly string[];
  readonly finalReview: {
    readonly id: typeof FINAL_REVIEW_NODE_ID;
    readonly kind: "final-review";
    readonly needs: readonly string[];
  };
}

export interface ExecutionPlanCompileResult {
  readonly plan?: ExecutionPlan;
  readonly errors: string[];
}

export interface ExecutionPlanSnapshot {
  plan: ExecutionPlan;
  expansion:
    | { status: "pending"; expandedNodeIds: readonly string[] }
    | { status: "expanded"; expandedNodeIds: readonly string[]; expandedAt: string };
}

export function compileExecutionPlan(ticketGraph: unknown): ExecutionPlanCompileResult {
  const validation = validateMultiAgentArtifact("acp.ticket-graph/v1", ticketGraph);
  if (!validation.ok || validation.value?.contract !== "acp.ticket-graph/v1") {
    return { errors: validation.errors };
  }
  const tickets = validation.value.tickets;
  const errors = validateTicketDependencies(tickets);
  if (errors.length > 0) return { errors };

  const dependents = new Map(tickets.map(ticket => [ticket.id, 0]));
  for (const ticket of tickets) {
    for (const dependency of ticket.needs) {
      dependents.set(dependency, (dependents.get(dependency) ?? 0) + 1);
    }
  }
  const terminalNodeIds = tickets
    .filter(ticket => dependents.get(ticket.id) === 0)
    .map(ticket => ticket.id)
    .sort();
  const plan: ExecutionPlan = {
    contract: EXECUTION_PLAN_CONTRACT,
    nodes: tickets.map(ticket => ({
      id: ticket.id,
      kind: "implementation",
      ticket: cloneJson(ticket),
      needs: [...ticket.needs],
    })),
    terminalNodeIds,
    finalReview: {
      id: FINAL_REVIEW_NODE_ID,
      kind: "final-review",
      needs: [...terminalNodeIds],
    },
  };
  return { plan: deepFreeze(plan), errors: [] };
}

export function validateExecutionPlan(value: unknown): ExecutionPlanCompileResult {
  if (!isRecord(value)) return { errors: ["Execution Plan must be an object."] };
  if (value.contract !== EXECUTION_PLAN_CONTRACT) {
    return { errors: [`Unsupported Execution Plan contract "${String(value.contract)}".`] };
  }
  const errors: string[] = [];
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) {
    errors.push("acp.execution-plan/v1.nodes must be a non-empty array.");
  }
  const nodes = Array.isArray(value.nodes) ? value.nodes : [];
  const ids = new Set<string>();
  const dependencies = new Map<string, string[]>();
  for (const [index, node] of nodes.entries()) {
    const label = `acp.execution-plan/v1.nodes[${index}]`;
    if (!isRecord(node)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    if (typeof node.id !== "string" || node.id.trim() === "") errors.push(`${label}.id must be a non-empty string.`);
    else if (ids.has(node.id)) errors.push(`${label}.id "${node.id}" is duplicated.`);
    else ids.add(node.id);
    if (node.kind !== "implementation") errors.push(`${label}.kind must equal "implementation".`);
    if (!isRecord(node.ticket) || node.ticket.id !== node.id) errors.push(`${label}.ticket.id must equal its stable node id.`);
    if (!isStringArray(node.needs)) errors.push(`${label}.needs must be an array of non-empty strings.`);
    else if (typeof node.id === "string") dependencies.set(node.id, [...node.needs]);
  }
  for (const [id, needs] of dependencies) {
    for (const need of needs) if (!ids.has(need)) errors.push(`Execution Plan node "${id}" depends on unknown node "${need}".`);
  }
  errors.push(...detectCycles(dependencies));

  const expectedTerminals = [...ids].filter(id =>
    ![...dependencies.values()].some(needs => needs.includes(id))
  ).sort();
  if (!isStringArray(value.terminalNodeIds) || !sameIds(value.terminalNodeIds, expectedTerminals)) {
    errors.push(`acp.execution-plan/v1.terminalNodeIds must equal the validated terminal nodes: ${expectedTerminals.join(", ")}.`);
  }
  if (!isRecord(value.finalReview)
    || value.finalReview.id !== FINAL_REVIEW_NODE_ID
    || value.finalReview.kind !== "final-review"
    || !isStringArray(value.finalReview.needs)
    || !sameIds(value.finalReview.needs, expectedTerminals)) {
    errors.push("acp.execution-plan/v1.finalReview.needs must equal all validated terminal nodes.");
  }
  return errors.length > 0
    ? { errors }
    : { plan: deepFreeze(cloneJson(value) as unknown as ExecutionPlan), errors: [] };
}

export function markExecutionPlanExpanded(
  snapshot: ExecutionPlanSnapshot,
  expandedNodeIds: readonly string[],
  expandedAt: string,
): ExecutionPlanSnapshot {
  if (snapshot.expansion.status === "expanded") {
    throw new Error("Execution Plan has already expanded; create a new plan version for newly discovered work.");
  }
  const validation = validateExecutionPlan(snapshot.plan);
  if (!validation.plan) throw new Error(`Invalid Execution Plan: ${validation.errors.join(" ")}`);
  const expected = [...validation.plan.nodes.map(node => node.id), validation.plan.finalReview.id].sort();
  if (!sameIds(expandedNodeIds, expected)) {
    throw new Error(`Execution Plan must expand exactly once with nodes: ${expected.join(", ")}.`);
  }
  if (typeof expandedAt !== "string" || Number.isNaN(Date.parse(expandedAt))) {
    throw new Error("Execution Plan expandedAt must be an ISO timestamp.");
  }
  return deepFreeze({
    plan: validation.plan,
    expansion: {
      status: "expanded",
      expandedNodeIds: [...expandedNodeIds],
      expandedAt,
    },
  });
}

function validateTicketDependencies(tickets: TicketGraphArtifact["tickets"]): string[] {
  const ids = new Set(tickets.map(ticket => ticket.id));
  const dependencies = new Map(tickets.map(ticket => [ticket.id, ticket.needs]));
  const errors: string[] = [];
  for (const ticket of tickets) {
    if (ticket.id === FINAL_REVIEW_NODE_ID) {
      errors.push(`Ticket identity "${FINAL_REVIEW_NODE_ID}" is reserved for the final review node.`);
    }
    for (const need of ticket.needs) {
      if (!ids.has(need)) errors.push(`Ticket "${ticket.id}" depends on unknown ticket "${need}".`);
    }
  }
  errors.push(...detectCycles(dependencies));
  return errors;
}

function detectCycles(dependencies: ReadonlyMap<string, readonly string[]>): string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycleNodes = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      cycleNodes.add(id);
      return;
    }
    if (visited.has(id) || !dependencies.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of dependencies.keys()) visit(id);
  return cycleNodes.size > 0
    ? [`Execution Plan contains a dependency cycle involving: ${[...cycleNodes].sort().join(", ")}.`]
    : [];
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && [...actual].sort().every((id, index) => id === expected[index]);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string" && item.trim() !== "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
