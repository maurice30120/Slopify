import type { ContentBlock, SessionNotification } from "@agentclientprotocol/sdk";

import type { NormalizedPromotionPolicy } from "./PipelinePolicy";
import type { PipelineStatus } from "./PipelineEvents";
import type { PipelineStepRunResult } from "./PipelineStepCompletion";
import type { PipelineArtifact } from "./PipelineV3Types";

export type PipelineSideEffects = "none" | "workspace";
export type PipelinePermissions = "ask" | "allowAll";

export interface PipelineStepStatusUpdate {
	status: PipelineStatus;
	message: string;
}

export type PipelineStepStatusHandler = (update: PipelineStepStatusUpdate) => void;

/**
 * Transport-independent prompt representation for a pipeline agent node.
 *
 * Skills are reusable methods, instructions define the invariant role and
 * rules, task contains the run-specific request, and context keeps the typed
 * artifacts available for previews, traces, sizing, and future renderers.
 */
export interface PipelineNodePrompt {
	skills: string[];
	instructions?: string;
	task: string;
	context: PipelineArtifact[];
}

export interface PipelineAcpPromptRenderOptions {
	renderSkills?: (skillNames: readonly string[]) => string;
}

/**
 * Converts a structured pipeline prompt at the ACP transport boundary.
 *
 * Context is intentionally not rendered as a fourth block yet because current
 * task templates already reference their typed artifacts explicitly. Keeping
 * it on PipelineNodePrompt avoids duplicating run data while preserving the
 * layer for UI previews, traces, accounting, and future capability-aware
 * adapters.
 */
export function renderAcpPrompt(
	input: PipelineNodePrompt,
	options: PipelineAcpPromptRenderOptions = {},
): ContentBlock[] {
	const blocks: ContentBlock[] = [];
	const skills = options.renderSkills?.(input.skills)?.trim() ?? "";
	if (skills) {
		blocks.push({
			type: "text",
			text: `<skills>\n${skills}\n</skills>`,
		});
	}

	const instructions = input.instructions?.trim();
	if (instructions) {
		blocks.push({
			type: "text",
			text: `<instructions>\n${instructions}\n</instructions>`,
		});
	}

	blocks.push({
		type: "text",
		text: `<task>\n${input.task}\n</task>`,
	});
	return blocks;
}

export interface PipelineAgentRunInput {
	runId?: string;
	nodeId?: string;
	attempt?: number;
	workspaceCwd: string;
	agentName: string;
	/** Structured prompt preferred by ACP-capable runners. */
	prompt?: PipelineNodePrompt;
	/** Legacy flattened task text retained for third-party runners. */
	promptText: string;
	onSessionUpdate?: (update: SessionNotification) => void;
	onStatus?: PipelineStepStatusHandler;
	signal?: AbortSignal;
	sideEffects?: PipelineSideEffects;
	permissions?: PipelinePermissions;
	promotion?: NormalizedPromotionPolicy;
	skills?: string[];
}

export type PipelineAgentRunner = (
	input: PipelineAgentRunInput,
) => Promise<PipelineStepRunResult>;
