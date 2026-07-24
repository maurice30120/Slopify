import * as fs from "node:fs";
import * as path from "node:path";

import * as yaml from "js-yaml";
import {
	compilePipelineV3Catalog,
	type CompiledPipelineProgram,
	type PipelineV3CatalogResult,
} from "@acp-client/pipeline";

import { loadAcpConfig, loadAgentCatalog } from "../config/config.js";
import type { Logger, AgentConfigEntry } from "../types.js";

const PIPELINE_DIR = path.join(".acp", "pipelines");

export function getPipelinePrograms(
	workspaceCwd: string,
	logger?: Logger,
): CompiledPipelineProgram[] {
	const catalog = loadAgentCatalog(workspaceCwd);
	const config = catalog.native;
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

export function getPipelineProgramForAgent(
	workspaceCwd: string,
	agentName: string,
	logger?: Logger,
): CompiledPipelineProgram | null {
	return (
		getPipelinePrograms(workspaceCwd, logger).find(
			(program) => program.id === agentName || program.title === agentName,
		) ?? null
	);
}

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

export interface PipelineProgramsFromRootOptions {
	workspaceCwd: string;
	configRoot: string;
	agentConfigs: Record<string, AgentConfigEntry>;
	instructionsMaxBytes?: number;
	logger?: Logger;
}

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
			sources.push({
				filePath,
				definition: parseYamlDocument(fs.readFileSync(filePath, "utf8")),
			});
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

function parseYamlDocument(text: string): unknown {
	return yaml.load(text);
}
