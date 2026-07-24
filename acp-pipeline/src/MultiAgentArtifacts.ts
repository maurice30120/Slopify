import type { PipelineArtifact, PipelineArtifactFormat } from "./PipelineV3Types";

export type MultiAgentArtifactContractId =
  | "acp.grill-decision/v1"
  | "acp.specification/v1"
  | "acp.ticket-graph/v1"
  | "acp.implementation-result/v1"
  | "acp.merge-result/v1"
  | "acp.verification-report/v1";

export interface ArtifactValidationResult<T = unknown> {
  ok: boolean;
  value?: T;
  errors: string[];
}

export interface GrillDecisionArtifact {
  contract: "acp.grill-decision/v1";
  decision: "continue" | "revise" | "stop";
  rationale: string;
  questions: string[];
}

export interface SpecificationArtifact {
  contract: "acp.specification/v1";
  title: string;
  summary: string;
  requirements: string[];
  nonGoals: string[];
}

export interface TicketGraphArtifact {
  contract: "acp.ticket-graph/v1";
  tickets: Array<{
    id: string;
    title: string;
    scope: string[];
    needs: string[];
    validation: string[];
    agent?: string;
  }>;
}

export interface ImplementationResultArtifact {
  contract: "acp.implementation-result/v1";
  ticketId: string;
  branch: string;
  commits: string[];
  summary: string;
  validations: string[];
}

export interface MergeResultArtifact {
  contract: "acp.merge-result/v1";
  sourceBranches: string[];
  integrationBranch: string;
  commits: string[];
  conflicts: Array<{ path: string; resolvedBy: string }>;
}

export interface VerificationReportArtifact {
  contract: "acp.verification-report/v1";
  verdict: "passed" | "failed";
  categories: Array<{
    name: string;
    required: boolean;
    status: "passed" | "failed" | "skipped";
    details: string;
  }>;
}

export type MultiAgentArtifact =
  | GrillDecisionArtifact
  | SpecificationArtifact
  | TicketGraphArtifact
  | ImplementationResultArtifact
  | MergeResultArtifact
  | VerificationReportArtifact;

const CONTRACT_FORMAT: Record<MultiAgentArtifactContractId, PipelineArtifactFormat> = {
  "acp.grill-decision/v1": "json",
  "acp.specification/v1": "json",
  "acp.ticket-graph/v1": "json",
  "acp.implementation-result/v1": "json",
  "acp.merge-result/v1": "json",
  "acp.verification-report/v1": "json",
};

export function validateMultiAgentArtifact(
  contract: string,
  payload: unknown,
): ArtifactValidationResult<MultiAgentArtifact> {
  if (!isKnownContract(contract)) {
    return { ok: false, errors: [`Unknown artifact contract "${contract}".`] };
  }
  if (!isRecord(payload)) {
    return { ok: false, errors: [`${contract} payload must be an object.`] };
  }
  const errors: string[] = [];
  if (payload.contract !== contract) {
    errors.push(`${contract}.contract must equal "${contract}".`);
  }

  switch (contract) {
    case "acp.grill-decision/v1":
      readEnum(payload.decision, `${contract}.decision`, ["continue", "revise", "stop"], errors);
      readString(payload.rationale, `${contract}.rationale`, errors);
      readStringArray(payload.questions, `${contract}.questions`, errors);
      break;
    case "acp.specification/v1":
      readString(payload.title, `${contract}.title`, errors);
      readString(payload.summary, `${contract}.summary`, errors);
      readStringArray(payload.requirements, `${contract}.requirements`, errors);
      readStringArray(payload.nonGoals, `${contract}.nonGoals`, errors);
      break;
    case "acp.ticket-graph/v1":
      validateTicketGraph(payload.tickets, errors);
      break;
    case "acp.implementation-result/v1":
      readString(payload.ticketId, `${contract}.ticketId`, errors);
      readString(payload.branch, `${contract}.branch`, errors);
      readStringArray(payload.commits, `${contract}.commits`, errors);
      readString(payload.summary, `${contract}.summary`, errors);
      readStringArray(payload.validations, `${contract}.validations`, errors);
      break;
    case "acp.merge-result/v1":
      readStringArray(payload.sourceBranches, `${contract}.sourceBranches`, errors);
      readString(payload.integrationBranch, `${contract}.integrationBranch`, errors);
      readStringArray(payload.commits, `${contract}.commits`, errors);
      validateConflicts(payload.conflicts, errors);
      break;
    case "acp.verification-report/v1":
      readEnum(payload.verdict, `${contract}.verdict`, ["passed", "failed"], errors);
      validateCategories(payload.categories, errors);
      break;
  }

  return errors.length === 0
    ? { ok: true, value: payload as unknown as MultiAgentArtifact, errors: [] }
    : { ok: false, errors };
}

export function publishMultiAgentArtifact(
  nodeId: string,
  name: string,
  contract: MultiAgentArtifactContractId,
  payload: unknown,
): ArtifactValidationResult<PipelineArtifact<MultiAgentArtifact>> {
  const validation = validateMultiAgentArtifact(contract, payload);
  if (!validation.ok || !validation.value) {
    return { ok: false, errors: validation.errors };
  }
  return {
    ok: true,
    errors: [],
    value: {
      name,
      type: contract,
      format: CONTRACT_FORMAT[contract],
      value: validation.value,
      producerNodeId: nodeId,
    },
  };
}

function validateTicketGraph(value: unknown, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("acp.ticket-graph/v1.tickets must be a non-empty array.");
    return;
  }
  const ids = new Set<string>();
  for (const [index, ticket] of value.entries()) {
    const label = `acp.ticket-graph/v1.tickets[${index}]`;
    if (!isRecord(ticket)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    const id = readString(ticket.id, `${label}.id`, errors);
    if (id && ids.has(id)) {
      errors.push(`${label}.id "${id}" is duplicated.`);
    }
    if (id) {
      ids.add(id);
    }
    readString(ticket.title, `${label}.title`, errors);
    readStringArray(ticket.scope, `${label}.scope`, errors);
    readStringArray(ticket.needs, `${label}.needs`, errors);
    readStringArray(ticket.validation, `${label}.validation`, errors);
    if (ticket.agent !== undefined) {
      readString(ticket.agent, `${label}.agent`, errors);
    }
  }
}

function validateConflicts(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("acp.merge-result/v1.conflicts must be an array.");
    return;
  }
  for (const [index, conflict] of value.entries()) {
    const label = `acp.merge-result/v1.conflicts[${index}]`;
    if (!isRecord(conflict)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    readString(conflict.path, `${label}.path`, errors);
    readString(conflict.resolvedBy, `${label}.resolvedBy`, errors);
  }
}

function validateCategories(value: unknown, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("acp.verification-report/v1.categories must be a non-empty array.");
    return;
  }
  for (const [index, category] of value.entries()) {
    const label = `acp.verification-report/v1.categories[${index}]`;
    if (!isRecord(category)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    readString(category.name, `${label}.name`, errors);
    if (typeof category.required !== "boolean") {
      errors.push(`${label}.required must be a boolean.`);
    }
    readEnum(category.status, `${label}.status`, ["passed", "failed", "skipped"], errors);
    readString(category.details, `${label}.details`, errors);
  }
}

function isKnownContract(value: string): value is MultiAgentArtifactContractId {
  return Object.prototype.hasOwnProperty.call(CONTRACT_FORMAT, value);
}

function readString(value: unknown, label: string, errors: string[]): string {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label} must be a non-empty string.`);
    return "";
  }
  return value;
}

function readStringArray(value: unknown, label: string, errors: string[]): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.trim() === "")) {
    errors.push(`${label} must be an array of non-empty strings.`);
    return [];
  }
  return value;
}

function readEnum(value: unknown, label: string, allowed: string[], errors: string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    errors.push(`${label} must be one of: ${allowed.join(", ")}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
