import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { CompiledPipelineProgram } from '@acp-client/pipeline';
import { loadSkillCatalog } from './skillCatalog.js';

interface SkillDependencies {
  dependencies: string[];
  requiredProjectFiles?: string[];
}

interface FrozenSkill {
  name: string;
  alias: string;
  description: string;
  relativePath: string;
  modelInvoked: boolean;
  dependencies: string[];
  requiredProjectFiles: string[];
}

interface FrozenFile {
  path: string;
  hash: string;
  executable: boolean;
}

type StoredProgram = Omit<CompiledPipelineProgram, 'nodesById' | 'dependentsById'> & {
  dependents: Array<[string, readonly string[]]>;
};

interface ResourceSnapshot {
  version: 1;
  runId: string;
  skills: FrozenSkill[];
  files: FrozenFile[];
  program?: StoredProgram;
}

export interface PreparedRunResources {
  root: string;
  sandboxRoot: string;
  files: Array<{ relativePath: string; contentBase64: string; executable: boolean }>;
  renderSkills(names: readonly string[], sandbox: boolean): string;
}

/** Owns skill resolution, prerequisites and durable copies shared by all nodes of a run. */
export class RunResources {
  private readonly root: string;

  constructor(private readonly options: {
    workspaceCwd: string;
    embeddedRoot?: string;
    stateRoot?: string;
  }) {
    this.root = options.stateRoot ?? resourcesDirectory(options.workspaceCwd);
  }

  prepare(runId: string, program?: CompiledPipelineProgram): PreparedRunResources {
    const root = this.runDirectory(runId);
    if (!fs.existsSync(path.join(root, 'snapshot.json'))) this.freeze(runId, root, program);
    const snapshot = this.read(root);
    const required = program?.nodes.flatMap(node => [...node.skills]) ?? [];
    this.checkPrerequisites(snapshot, required);
    return this.prepared(root, snapshot);
  }

  restoreProgram(runId: string): CompiledPipelineProgram {
    const snapshot = this.read(this.runDirectory(runId));
    if (!snapshot.program) throw new Error(`Frozen pipeline missing for run ${runId}; cannot safely resume.`);
    const { dependents, ...program } = snapshot.program;
    this.checkPrerequisites(snapshot, program.nodes.flatMap(node => [...node.skills]));
    return {
      ...program,
      nodesById: new Map(program.nodes.map(node => [node.id, node])),
      dependentsById: new Map(dependents),
    };
  }

  restore(runId: string): PreparedRunResources {
    const root = this.runDirectory(runId);
    return this.prepared(root, this.read(root));
  }

  private runDirectory(runId: string): string {
    return path.join(this.root, digest(runId));
  }

  private freeze(runId: string, root: string, program?: CompiledPipelineProgram): void {
    const skills: FrozenSkill[] = [];
    const staging = `${root}.${randomUUID()}.tmp`;
    const manifest: { skills: Record<string, SkillDependencies> } = this.options.embeddedRoot
      ? JSON.parse(fs.readFileSync(path.join(this.options.embeddedRoot, 'manifest.json'), 'utf8'))
      : { skills: {} };
    fs.mkdirSync(staging, { recursive: true });
    try {
      for (const [origin, source] of [
        ['slopify', this.options.embeddedRoot],
        ['project', this.options.workspaceCwd],
      ] as const) {
        if (!source) continue;
        for (const entry of loadSkillCatalog({ workspaceCwd: source })) {
          const alias = path.basename(path.dirname(entry.filePath));
          const metadata = origin === 'slopify' ? manifest.skills[alias] : undefined;
          if (origin === 'slopify' && !metadata) throw new Error(`Skill absent from bundle manifest: ${alias}`);
          const relativePath = `${origin}/${alias}/SKILL.md`;
          fs.cpSync(path.dirname(entry.filePath), path.dirname(path.join(staging, relativePath)), {
            recursive: true, dereference: true,
          });
          skills.push({
            name: `${origin}:${entry.name}`,
            alias: `${origin}:${alias}`,
            description: entry.description,
            relativePath,
            modelInvoked: !entry.disableModelInvocation,
            dependencies: (metadata?.dependencies ?? []).map(name => `${origin}:${name}`),
            requiredProjectFiles: metadata?.requiredProjectFiles ?? [],
          });
        }
      }
      const snapshot: ResourceSnapshot = {
        version: 1, runId, skills, files: inventory(staging),
        ...(program ? { program: storeProgram(program) } : {}),
      };
      this.checkPrerequisites(snapshot, program?.nodes.flatMap(node => [...node.skills]) ?? []);
      fs.writeFileSync(path.join(staging, 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n');
      fs.mkdirSync(path.dirname(root), { recursive: true });
      fs.renameSync(staging, root);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  private read(root: string): ResourceSnapshot {
    if (!fs.existsSync(path.join(root, 'snapshot.json'))) {
      throw new Error(`Frozen run resources missing at ${root}; restore them before resuming.`);
    }
    const snapshot: ResourceSnapshot = JSON.parse(fs.readFileSync(path.join(root, 'snapshot.json'), 'utf8'));
    if (snapshot.version !== 1) throw new Error('Unsupported run resources version.');
    for (const file of snapshot.files) {
      const absolute = within(root, file.path);
      if (!fs.existsSync(absolute) || digest(fs.readFileSync(absolute)) !== file.hash) {
        throw new Error(`Frozen run resource changed or missing: ${file.path}. Restore the original before resuming.`);
      }
    }
    return snapshot;
  }

  private checkPrerequisites(snapshot: ResourceSnapshot, names: readonly string[]): void {
    for (const skill of resolveSkills(snapshot.skills, names, true)) {
      for (const relative of skill.requiredProjectFiles) {
        const file = within(this.options.workspaceCwd, relative);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile() || !fs.readFileSync(file, 'utf8').trim()) {
          throw new Error(`Skill ${skill.name} requires project configuration ${relative}. Create this file with the project's tracker workflow before running the pipeline.`);
        }
      }
    }
  }

  private prepared(root: string, snapshot: ResourceSnapshot): PreparedRunResources {
    // This path is outside the cloned repository, so resources cannot enter Agent Checkpoints.
    const sandboxRoot = `/tmp/slopify-resources/${digest(this.options.workspaceCwd + '\0' + snapshot.runId)}`;
    return {
      root, sandboxRoot,
      files: snapshot.files.map(file => ({
        relativePath: file.path,
        contentBase64: fs.readFileSync(within(root, file.path)).toString('base64'),
        executable: file.executable,
      })),
      renderSkills: (names, sandbox) => {
        this.checkPrerequisites(snapshot, names);
        const selected = resolveSkills(snapshot.skills, names, false);
        const dependencies = resolveSkills(snapshot.skills, names, true);
        const selectedNames = new Set(selected.map(skill => skill.name));
        const available = snapshot.skills.filter(skill => !selectedNames.has(skill.name)
          && (skill.modelInvoked || dependencies.some(dependency => dependency.name === skill.name)));
        if (!selected.length && !available.length) return '';
        const base = sandbox ? sandboxRoot : root;
        const describe = (skill: FrozenSkill) => `- ${skill.name}: ${skill.description} (path: ${sandbox ? path.posix.join(base, skill.relativePath) : path.join(base, skill.relativePath)})`;
        return [
          'Read each required SKILL.md before acting and follow it. Read other skills only when relevant or called by a required skill.',
          'Resolve relative resource links from the skill directory. For a skill calling /name or the Skill tool, read the catalog entry from the same origin (slopify: or project:); do not substitute a homonymous skill from another origin.',
          ...(selected.length ? ['Required skills:', ...selected.map(describe)] : []),
          ...(available.length ? ['Available skills:', ...available.map(describe)] : []),
        ].join('\n');
      },
    };
  }
}

function resolveSkills(skills: FrozenSkill[], names: readonly string[], dependencies: boolean): FrozenSkill[] {
  const result = new Map<string, FrozenSkill>();
  function visit(reference: string): void {
    const name = reference.trim().replace(/^\//, '').toLowerCase();
    const qualified = name.includes(':') ? name : `project:${name}`;
    const matches = skills.filter(skill => [skill.name.toLowerCase(), skill.alias.toLowerCase()].includes(qualified));
    if (matches.length !== 1) throw new Error(`Pipeline skill "${reference}" is ${matches.length ? 'ambiguous' : 'missing'}. Use slopify:<name> or project:<name>.`);
    const skill = matches[0];
    if (result.has(skill.name)) return;
    result.set(skill.name, skill);
    if (dependencies) skill.dependencies.forEach(visit);
  }
  names.forEach(visit);
  return [...result.values()];
}

function storeProgram(program: CompiledPipelineProgram): StoredProgram {
  const { nodesById: _nodes, dependentsById, ...rest } = program;
  return { ...rest, dependents: [...dependentsById] };
}

function resourcesDirectory(workspaceCwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'slopify/resources'], {
      cwd: workspaceCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return path.resolve(workspaceCwd, '.acp/runs-v3/resources');
  }
}

function within(root: string, relative: string): string {
  const absolute = path.resolve(root, relative);
  const fromRoot = path.relative(root, absolute);
  if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) throw new Error(`Resource path escapes root: ${relative}`);
  return absolute;
}

function inventory(root: string, relative = ''): FrozenFile[] {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) return inventory(root, file);
    const absolute = path.join(root, file);
    return [{ path: file, hash: digest(fs.readFileSync(absolute)), executable: (fs.statSync(absolute).mode & 0o111) !== 0 }];
  });
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
