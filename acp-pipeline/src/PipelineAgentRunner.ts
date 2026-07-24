import type { ContentBlock, SessionNotification } from "@agentclientprotocol/sdk";

import type { NormalizedPromotionPolicy } from "./PipelinePolicy";
import type { PipelineStatus } from "./PipelineEvents";
import type {
	PipelinePromotionStatus,
	PipelineStepRunResult,
} from "./PipelineStepCompletion";
import type {
	CompiledPipelineProgram,
	PipelineArtifact,
} from "./PipelineV3Types";

export type PipelineSideEffects = "none" | "workspace";
export type PipelinePermissions = "ask" | "allowAll";

export interface PipelineStepStatusUpdate {
	status: PipelineStatus;
	message: string;
}

export type PipelineStepStatusHandler = (update: PipelineStepStatusUpdate) => void;

/**
 * Représentation d'un prompt de nœud agent indépendante du transport.
 *
 * Les skills représentent les méthodes réutilisables, les instructions portent
 * le rôle et les règles invariants, et la tâche contient la demande propre au
 * run. Le contexte conserve les artefacts typés pour les aperçus, traces,
 * métriques de taille et futurs moteurs de rendu.
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
 * Convertit un prompt structuré à la frontière du transport ACP.
 *
 * Le contexte n'est volontairement pas rendu comme quatrième bloc : les modèles
 * de tâche actuels référencent déjà explicitement leurs artefacts typés. Le
 * conserver dans PipelineNodePrompt évite de dupliquer les données du run tout
 * en le rendant disponible aux aperçus, traces, métriques et futurs adaptateurs.
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
	/** Prompt structuré privilégié par les runners compatibles ACP. */
	prompt?: PipelineNodePrompt;
	/** Texte aplati conservé pour la compatibilité avec les runners tiers. */
	promptText: string;
	onSessionUpdate?: (update: SessionNotification) => void;
	onStatus?: PipelineStepStatusHandler;
	signal?: AbortSignal;
	sideEffects?: PipelineSideEffects;
	permissions?: PipelinePermissions;
	promotion?: NormalizedPromotionPolicy;
	skills?: string[];
}

export interface PipelineChangeSetPreview {
	baseCommit: string;
	changeSetCommit: string;
	fileCount: number;
	files: string[];
	diff: string;
}

export interface PipelineChangeSetFinalizationInput {
	runId: string;
	program: CompiledPipelineProgram;
}

export interface PipelineChangeSetFinalizationResult {
	promotion: PipelinePromotionStatus;
	preview: PipelineChangeSetPreview;
	changeSetRef?: string;
	changeSetCommit?: string;
	integratedNodeIds: string[];
}

export interface PipelineAgentRunner {
	(input: PipelineAgentRunInput): Promise<PipelineStepRunResult>;
	finalizePipelineChangeSet?(
		input: PipelineChangeSetFinalizationInput,
	): Promise<PipelineChangeSetFinalizationResult>;
}
