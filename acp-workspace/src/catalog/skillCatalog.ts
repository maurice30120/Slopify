import * as fs from "node:fs";
import * as path from "node:path";

import {
	renderExplicitPipelineSkills,
	resolveExplicitPipelineSkills,
	type PipelineSkillEntry,
} from "@acp-client/pipeline";

/** Contrat fonctionnel de SkillCatalogEntry dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface SkillCatalogEntry extends PipelineSkillEntry {
	name: string;
	description: string;
	disableModelInvocation: boolean;
	filePath: string;
	content: string;
}

/** Contrat fonctionnel de SkillCatalogOptions dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface SkillCatalogOptions {
	workspaceCwd: string;
	logger?: (message: string, error?: unknown) => void;
}

const SKILLS_DIR = path.join(".agents", "skills");
const SKILL_FILE = "SKILL.md";

/**
 * Parcourt `.agents/skills/<name>/SKILL.md` et analyse le frontmatter YAML
 * (`name`, `description`, `disable-model-invocation`). Une skill sans `name`
 * ou `description`, ou dont l'analyse échoue, est ignorée.
 */
export function loadSkillCatalog(
	options: SkillCatalogOptions,
): SkillCatalogEntry[] {
	const dir = path.join(options.workspaceCwd, SKILLS_DIR);
	if (!fs.existsSync(dir)) {
		return [];
	}

	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch (e: unknown) {
		options.logger?.(`Failed to read skills directory ${dir}`, e);
		return [];
	}

	const catalog: SkillCatalogEntry[] = [];
	for (const entry of entries.sort()) {
		const skillDir = path.join(dir, entry);
		const filePath = path.join(skillDir, SKILL_FILE);
		if (!fs.existsSync(filePath)) {
			continue;
		}

		let text: string;
		try {
			text = fs.readFileSync(filePath, "utf8");
		} catch (e: unknown) {
			options.logger?.(`Failed to read skill ${filePath}`, e);
			continue;
		}

		const parsed = parseSkillFrontmatter(text);
		if (!parsed) {
			continue;
		}

		catalog.push({
			name: parsed.name,
			description: parsed.description,
			disableModelInvocation: parsed.disableModelInvocation,
			filePath,
			content: text,
		});
	}

	return catalog;
}

/** Contrat fonctionnel de ParsedSkillFrontmatter dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
interface ParsedSkillFrontmatter {
	name: string;
	description: string;
	disableModelInvocation: boolean;
}

/** Point d'entrée parseSkillFrontmatter du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function parseSkillFrontmatter(text: string): ParsedSkillFrontmatter | null {
	const frontmatter = extractFrontmatter(text);
	if (!frontmatter) {
		return null;
	}

	const name = readScalar(frontmatter, "name");
	const description = readScalar(frontmatter, "description");
	if (!name || !description) {
		return null;
	}

	const disable = readScalar(frontmatter, "disable-model-invocation");
	return {
		name,
		description,
		disableModelInvocation: disable === "true",
	};
}

/** Point d'entrée extractFrontmatter du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function extractFrontmatter(text: string): string | null {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	return match ? match[1] : null;
}

/** Point d'entrée readScalar du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function readScalar(frontmatter: string, key: string): string {
	const re = new RegExp(
		`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(.*)$`,
		"m",
	);
	const match = re.exec(frontmatter);
	if (!match) {
		return "";
	}
	return match[1].trim().replace(/^(["'])|(["'])$/g, "");
}

/**
 * Construit les blocs `<skill>` explicites d'une étape de pipeline. Les skills
 * déclarées par un nœud sont injectées même si leur découverte automatique par
 * le modèle est désactivée.
 */
export function renderSkillsCatalog(
	catalog: SkillCatalogEntry[],
	allowList: string[] | undefined,
	workspaceCwd: string,
): string {
	if (!allowList || allowList.length === 0) {
		return "";
	}
	const resolved = resolveExplicitPipelineSkills(allowList, catalog, workspaceCwd);
	if (resolved.errors.length > 0) {
		throw new Error(`Unable to resolve pipeline skills: ${resolved.errors.join("; ")}`);
	}
	return renderExplicitPipelineSkills(resolved.skills);
}
