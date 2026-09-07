import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";

import {
	renderExplicitPipelineSkills,
	resolveExplicitPipelineSkills,
	type PipelineSkillEntry,
} from "@acp-client/pipeline";

export interface SkillCatalogEntry extends PipelineSkillEntry {
	name: string;
	description: string;
	disableModelInvocation: boolean;
	filePath: string;
	content: string;
}

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

interface ParsedSkillFrontmatter {
	name: string;
	description: string;
	disableModelInvocation: boolean;
}

function parseSkillFrontmatter(text: string): ParsedSkillFrontmatter | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  try {
    const value = yaml.load(match[1]);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const fields = value as Record<string, unknown>;
    if (typeof fields.name !== 'string' || !fields.name.trim()
      || typeof fields.description !== 'string' || !fields.description.trim()) return null;
    return {
      name: fields.name.trim(), description: fields.description.trim(),
      disableModelInvocation: fields['disable-model-invocation'] === true,
    };
  } catch { return null; }
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
