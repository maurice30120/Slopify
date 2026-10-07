import * as fs from "node:fs";
import * as path from "node:path";

import * as yaml from "js-yaml";
import {
	compilePipelineV3Catalog,
	type CompiledPipelineProgram,
	type PipelineV3CatalogResult,
	validateSandboxNodeNetworkPolicies,
} from "@acp-client/pipeline";

import { loadAcpConfig, loadAgentCatalog } from "../config/config.js";
import type { Logger, AgentConfigEntry } from "../types.js";

const PIPELINE_DIR = path.join(".acp", "pipelines");

/** Point d'entrée getPipelinePrograms du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
export function getPipelinePrograms(
	workspaceCwd: string,
	logger?: Logger,
): CompiledPipelineProgram[] {
	const catalog = loadAgentCatalog(workspaceCwd);
	const config = catalog.config;
	if (!config.pipeline.enabled) {
		return [];
	}

	for (const error of catalog.errors) {
		logger?.error(error);
	}

	return loadPipelineProgramsFromRoot({
		workspaceCwd,
		configRoot: workspaceCwd,
		agentConfigs: catalog.agents,
		instructionsMaxBytes: config.pipeline.instructionsMaxBytes,
		logger,
	}).programs;
}

/** Point d'entrée getPipelineProgramForAgent du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
export function getPipelineProgramForAgent(
	workspaceCwd: string,
	agentName: string,
	logger?: Logger,
): CompiledPipelineProgram | null {
	return (
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
		getPipelinePrograms(workspaceCwd, logger).find(
			(program) => program.id === agentName || program.title === agentName,
		) ?? null
	);
}

/** Point d'entrée loadWorkspacePipelinePrograms du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
export function loadWorkspacePipelinePrograms(
	workspaceCwd: string,
	agentConfigs: Record<string, AgentConfigEntry>,
	logger?: Logger,
): PipelineV3CatalogResult {
	return loadPipelineProgramsFromRoot({
		workspaceCwd,
		configRoot: workspaceCwd,
		agentConfigs,
		instructionsMaxBytes: loadAcpConfig(workspaceCwd).pipeline.instructionsMaxBytes,
		logger,
	});
}

/** Contrat fonctionnel de PipelineProgramsFromRootOptions dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineProgramsFromRootOptions {
	workspaceCwd: string;
	configRoot: string;
	agentConfigs: Record<string, AgentConfigEntry>;
	instructionsMaxBytes?: number;
	logger?: Logger;
}

/** Point d'entrée loadPipelineProgramsFromRoot du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
export function loadPipelineProgramsFromRoot(
	options: PipelineProgramsFromRootOptions,
): PipelineV3CatalogResult {
	const maxBytes = options.instructionsMaxBytes ?? 256 * 1024;
	const dir = path.join(options.configRoot, PIPELINE_DIR);
	if (!fs.existsSync(dir)) {
		return { programs: [], errors: [] };
	}

	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch (e: unknown) {
		options.logger?.error(`Failed to read ACP pipeline directory ${dir}`, e);
		return {
			programs: [],
			errors: [{
				filePath: dir,
				errors: [`Failed to read ACP pipeline directory: ${e instanceof Error ? e.message : String(e)}`],
			}],
		};
	}

	const sources: Array<{ filePath: string; definition: unknown }> = [];
	const errors: Array<{ filePath: string; errors: string[] }> = [];
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) {
			continue;
		}
		const filePath = path.join(dir, entry);
		try {
			const definition = parseYamlDocument(fs.readFileSync(filePath, "utf8"));
			const policyErrors = validateSandboxNodeNetworkPolicies(definition, options.agentConfigs);
			if (policyErrors.length > 0) {
				errors.push({ filePath, errors: policyErrors });
				continue;
			}
			sources.push({ filePath, definition });
		} catch (e: unknown) {
			const message = e instanceof Error && e.message ? e.message : String(e);
			errors.push({ filePath, errors: [`YAML parse error: ${message}`] });
		}
	}

	const result = compilePipelineV3Catalog(sources, {
		workspaceCwd: options.workspaceCwd,
		configRoot: options.configRoot,
		maxInstructionsFileBytes: maxBytes,
		agentConfigs: options.agentConfigs,
	});
	const combined = { programs: result.programs, errors: [...errors, ...result.errors] };
	for (const error of combined.errors) {
		options.logger?.error(
			`Ignoring invalid ACP pipeline ${error.filePath}: ${error.errors.join("; ")}`,
		);
	}
	return combined;
}

/** Point d'entrée parseYamlDocument du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function parseYamlDocument(text: string): unknown {
	return yaml.load(text);
}
