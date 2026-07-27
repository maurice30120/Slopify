import type { PipelinePolicyReference } from "./PipelineV3Types";

export type NormalizedFilesystemPolicy = "read-only" | "workspace-write";
export type NormalizedTerminalPolicy = "none" | "read-only" | "workspace-write";
export type NormalizedNetworkPolicy = "disabled" | "enabled";
export type NormalizedPromotionPolicy = "discard" | "ask" | "auto-apply" | "auto-reject";

export interface NormalizedPipelinePolicy {
  filesystem: NormalizedFilesystemPolicy;
  terminal: NormalizedTerminalPolicy;
  network: NormalizedNetworkPolicy;
  promotion: NormalizedPromotionPolicy;
}

export interface PipelineAdapterPolicyCapabilities {
  filesystem: readonly NormalizedFilesystemPolicy[];
  terminal: readonly NormalizedTerminalPolicy[];
  network: readonly NormalizedNetworkPolicy[] | "inherited";
  promotion: readonly NormalizedPromotionPolicy[] | "pipeline";
}

export interface PipelinePolicyDenial {
  code: "unsupported_policy" | "policy_denied";
  field?: keyof NormalizedPipelinePolicy;
  message: string;
}

export type PipelineToolPermissionKind =
  | "read"
  | "search"
  | "fetch"
  | "edit"
  | "delete"
  | "move"
  | "execute"
  | string;

export const READ_ONLY_PIPELINE_POLICY: NormalizedPipelinePolicy = Object.freeze({
  filesystem: "read-only",
  terminal: "none",
  network: "disabled",
  promotion: "discard",
});

export const WORKSPACE_WRITE_PIPELINE_POLICY: NormalizedPipelinePolicy = Object.freeze({
  filesystem: "workspace-write",
  terminal: "workspace-write",
  network: "disabled",
  promotion: "ask",
});

export const NATIVE_ACP_BASELINE_CAPABILITIES: PipelineAdapterPolicyCapabilities = Object.freeze({
  filesystem: ["read-only", "workspace-write"] as const,
  terminal: ["none", "read-only", "workspace-write"] as const,
  network: ["disabled"] as const,
  promotion: ["discard"] as const,
});

export const SANDBOX_BASELINE_CAPABILITIES: PipelineAdapterPolicyCapabilities = Object.freeze({
  filesystem: ["read-only", "workspace-write"] as const,
  terminal: ["none", "read-only", "workspace-write"] as const,
  // Docker Sandbox network policy is global and is not a node-level guarantee.
  network: "inherited",
  promotion: "pipeline",
});

export function normalizePipelinePolicy(policy: PipelinePolicyReference | undefined): NormalizedPipelinePolicy {
  return Object.freeze({
    filesystem: policy?.filesystem ?? READ_ONLY_PIPELINE_POLICY.filesystem,
    terminal: policy?.terminal ?? READ_ONLY_PIPELINE_POLICY.terminal,
    network: policy?.network ?? READ_ONLY_PIPELINE_POLICY.network,
    promotion: policy?.promotion ?? READ_ONLY_PIPELINE_POLICY.promotion,
  });
}

export function validateAdapterSupportsPolicy(
  adapterName: string,
  capabilities: PipelineAdapterPolicyCapabilities,
  policy: NormalizedPipelinePolicy,
): PipelinePolicyDenial[] {
  // Une politique non garantie est refusée avant l'exécution plutôt que dégradée
  // silencieusement : l'isolation annoncée au pipeline doit rester vraie quel
  // que soit l'adaptateur choisi.
  const denials: PipelinePolicyDenial[] = [];
  for (const field of ["filesystem", "terminal", "network", "promotion"] as const) {
    const supported = capabilities[field];
    if (field === "network" && supported === "inherited") continue;
    if (field === "promotion" && supported === "pipeline") continue;
    if (!(supported as readonly string[]).includes(policy[field])) {
      denials.push({
        code: "unsupported_policy",
        field,
        message: `${adapterName} adapter cannot guarantee ${field} policy "${policy[field]}".`,
      });
    }
  }
  return denials;
}

export function evaluateToolPermissionForPolicy(
  policy: NormalizedPipelinePolicy,
  kind: PipelineToolPermissionKind | null | undefined,
): PipelinePolicyDenial | null {
  switch (kind) {
    case "read":
    case "search":
      return null;
    case "fetch":
      return policy.network === "enabled"
        ? null
        : {
            code: "policy_denied",
            field: "network",
            message: "Network fetch is denied by the node policy.",
          };
    case "edit":
    case "delete":
    case "move":
      return policy.filesystem === "workspace-write"
        ? null
        : {
            code: "policy_denied",
            field: "filesystem",
            message: "Workspace file mutation is denied by the node policy.",
          };
    case "execute":
      return policy.terminal === "workspace-write"
        ? null
        : {
            code: "policy_denied",
            field: "terminal",
            message: "Terminal execution is denied by the node policy.",
          };
    default:
      return {
        code: "policy_denied",
        message: `Tool permission kind "${kind ?? "unknown"}" is denied unless an adapter maps it explicitly.`,
      };
  }
}

export function mapPolicyToLegacySideEffects(policy: NormalizedPipelinePolicy): "none" | "workspace" {
  return policy.filesystem === "workspace-write" || policy.terminal === "workspace-write"
    ? "workspace"
    : "none";
}

export function mapPolicyToLegacyPermissions(_policy: NormalizedPipelinePolicy): "ask" | "allowAll" {
  // Le vocabulaire legacy ne peut pas exprimer les quatre axes de la politique.
  // Conserver `ask` évite qu'une conversion approximative élargisse les droits.
  return "ask";
}
