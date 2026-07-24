export interface PipelineSkillEntry {
  name: string;
  description: string;
  filePath: string;
  relativePath?: string;
  content?: string;
  disableModelInvocation?: boolean;
  enabled?: boolean;
}

export interface ResolvedPipelineSkill {
  name: string;
  description: string;
  filePath: string;
  relativePath: string;
  content?: string;
  modelInvoked: boolean;
}

export interface PipelineSkillResolutionResult {
  skills: ResolvedPipelineSkill[];
  errors: string[];
}

export function discoverModelInvokedSkills(
  entries: readonly PipelineSkillEntry[],
  workspaceCwd: string,
): ResolvedPipelineSkill[] {
  return normalizeSkillEntries(entries, workspaceCwd)
    .filter(skill => skill.modelInvoked)
    .sort(compareSkills);
}

export function resolveExplicitPipelineSkills(
  requestedNames: readonly string[] | undefined,
  entries: readonly PipelineSkillEntry[],
  workspaceCwd: string,
  agentAllowedSkills?: readonly string[] | boolean,
): PipelineSkillResolutionResult {
  if (!requestedNames || requestedNames.length === 0) {
    return { skills: [], errors: [] };
  }

  const normalizedEntries = normalizeSkillEntries(entries, workspaceCwd);
  const byName = new Map<string, ResolvedPipelineSkill[]>();
  for (const entry of normalizedEntries) {
    addSkillAlias(byName, normalizeSkillName(entry.name), entry);
    addSkillAlias(byName, normalizeSkillName(folderNameFromPath(entry.filePath)), entry);
  }
  const allowedNames = normalizeAllowedSkills(agentAllowedSkills);
  const skills: ResolvedPipelineSkill[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const requested of requestedNames) {
    const key = normalizeSkillName(requested);
    if (!key) {
      errors.push("Skill names must be non-empty strings.");
      continue;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const matches = byName.get(key) ?? [];
    if (matches.length === 0) {
      errors.push(`Pipeline node references missing skill "${requested}".`);
      continue;
    }
    if (matches.length > 1) {
      errors.push(`Pipeline node skill "${requested}" is ambiguous: ${matches.map(skill => skill.relativePath).join(", ")}.`);
      continue;
    }
    const skill = matches[0];
    if (allowedNames && !allowedNames.has(normalizeSkillName(skill.name)) && !allowedNames.has(normalizeSkillName(folderNameFromPath(skill.filePath)))) {
      errors.push(`Pipeline node skill "${requested}" is disabled for this agent.`);
      continue;
    }
    skills.push(skill);
  }

  return {
    skills: skills.sort(compareSkills),
    errors,
  };
}

export function renderExplicitPipelineSkills(skills: readonly ResolvedPipelineSkill[]): string {
  if (skills.length === 0) {
    return "";
  }
  return skills
    .map(skill => {
      const content = skill.content?.trim();
      const body = content && content.length > 0
        ? content
        : `Skill content unavailable at ${skill.relativePath}.`;
      return [`<skill name="${escapeAttribute(skill.name)}">`, body, "</skill>"].join("\n");
    })
    .join("\n\n");
}

export function renderModelSkillCatalog(skills: readonly ResolvedPipelineSkill[]): string {
  const modelInvoked = skills.filter(skill => skill.modelInvoked).sort(compareSkills);
  if (modelInvoked.length === 0) {
    return "";
  }
  const lines = modelInvoked.map(skill => {
    const description = skill.description || "(no description)";
    return `- ${skill.name}: ${description} (path: ${skill.relativePath})`;
  });
  return [
    "When a skill is relevant, read its SKILL.md via the filesystem before acting.",
    "When the user types /skill-name, follow that skill fully.",
    "",
    ...lines,
  ].join("\n");
}

function normalizeSkillEntries(entries: readonly PipelineSkillEntry[], workspaceCwd: string): ResolvedPipelineSkill[] {
  return entries
    .filter(entry => entry.enabled !== false)
    .map(entry => ({
      name: entry.name.trim(),
      description: entry.description.trim(),
      filePath: entry.filePath,
      relativePath: (entry.relativePath ?? makeRelativePath(workspaceCwd, entry.filePath)).replace(/\\/g, "/"),
      content: entry.content,
      modelInvoked: entry.disableModelInvocation !== true,
    }))
    .filter(entry => entry.name.length > 0 && entry.filePath.length > 0);
}

function normalizeAllowedSkills(agentAllowedSkills: readonly string[] | boolean | undefined): Set<string> | null {
  if (agentAllowedSkills === undefined || agentAllowedSkills === true) {
    return null;
  }
  if (agentAllowedSkills === false) {
    return new Set();
  }
  return new Set(agentAllowedSkills.map(normalizeSkillName).filter(Boolean));
}

function addSkillAlias(
  byName: Map<string, ResolvedPipelineSkill[]>,
  alias: string,
  skill: ResolvedPipelineSkill,
): void {
  if (!alias) {
    return;
  }
  const existing = byName.get(alias) ?? [];
  if (!existing.some(candidate => candidate.relativePath === skill.relativePath)) {
    existing.push(skill);
  }
  byName.set(alias, existing);
}

function compareSkills(left: ResolvedPipelineSkill, right: ResolvedPipelineSkill): number {
  return compareBytewise(left.name.toLowerCase(), right.name.toLowerCase())
    || compareBytewise(left.relativePath, right.relativePath);
}

function normalizeSkillName(value: string): string {
  return value.replace(/^\//, "").trim().toLowerCase();
}

function folderNameFromPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").at(-2) ?? "";
}

function makeRelativePath(workspaceCwd: string, filePath: string): string {
  const normalizedWorkspace = workspaceCwd.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedFile = filePath.replace(/\\/g, "/");
  return normalizedFile.startsWith(`${normalizedWorkspace}/`)
    ? normalizedFile.slice(normalizedWorkspace.length + 1)
    : normalizedFile;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function compareBytewise(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
