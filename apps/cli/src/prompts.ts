import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Aide de la commande `slopify prompts`, reprise dans l'aide générale de la CLI. */
export const promptsHelp = `Inspect the versioned implement and code-review prompt workflows (read-only):
  slopify prompts                              List roles, entries, dependencies and provenance.
  slopify prompts <implementer|reviewer>      Print the exact entry prompt of a role.
  slopify prompts <path under the bundle>     Print the exact content of any bundled resource.
  slopify prompts --check                     Verify declared resources and internal references.
The prompts are embedded with the CLI: no external skills store is read, no secret or run-specific value is displayed.`;

/** Révision amont d'où provient l'extraction embarquée. */
export interface PromptsSource {
  repository: string;
  commit: string;
  extractedFrom?: string;
}

/** Dépendance embarquée d'un rôle : chemin dans le bundle, condition d'application et fichier qui la référence. */
export interface PromptsDependency {
  path: string;
  condition?: string;
  via?: string;
}

/** Point d'entrée d'un rôle (implémenteur ou reviewer) et ses dépendances transitives embarquées. */
export interface PromptsRole {
  entry: string;
  summary: string;
  dependencies: PromptsDependency[];
}

/** Inventaire explicite du bundle, lu depuis prompts/inventory.json. */
export interface PromptsInventory {
  version: number;
  source: PromptsSource;
  bundleRoot: string;
  roles: { implementer: PromptsRole; reviewer: PromptsRole };
  sharedResources: { path: string; note: string }[];
  projectProvided: { reference: string; note: string }[];
  adaptations: { path: string; patch: string; summary: string }[];
}

/** Bundle chargé depuis la racine des prompts du package. */
export interface PromptsBundle {
  root: string;
  inventory: PromptsInventory;
}

/** Racine du bundle de prompts embarqué dans le package ; indépendante du répertoire courant. */
export function promptsPackageRoot(): string {
  return fileURLToPath(new URL('../../prompts', import.meta.url));
}

/** Charge l'inventaire du bundle de prompts depuis la racine donnée. */
export async function loadPromptsBundle(root = promptsPackageRoot()): Promise<PromptsBundle> {
  const inventoryPath = path.join(root, 'inventory.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(inventoryPath, 'utf8'));
  } catch (error: unknown) {
    throw new Error(`Cannot read the prompts inventory at ${inventoryPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const inventory = parsed as PromptsInventory;
  if (typeof inventory?.source?.commit !== 'string' || !inventory.roles?.implementer?.entry || !inventory.roles?.reviewer?.entry) {
    throw new Error(`Invalid prompts inventory at ${inventoryPath}: expected source.commit and implementer/reviewer roles.`);
  }
  return { root, inventory };
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function listMarkdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => path.join(entry.parentPath, entry.name));
}

/** Liens Markdown internes `[label](target.md)` d'un fichier du bundle. */
function markdownLinks(content: string): string[] {
  return [...content.matchAll(/\]\(([^)#\s]+\.md)\)/g)].map(match => match[1]);
}

/**
 * Vérifications publiques du bundle : ressources déclarées présentes, chaque fichier du bundle déclaré,
 * et références Markdown internes résolubles sans sortir du bundle.
 */
export async function checkPromptsBundle(bundle: PromptsBundle): Promise<string[]> {
  const { root, inventory } = bundle;
  const problems: string[] = [];
  const bundleRoot = path.join(root, inventory.bundleRoot);
  const declared = new Set<string>();
  const declare = (relative: string, kind: string) => {
    declared.add(relative);
    return fileExists(path.join(root, relative)).then(exists => {
      if (!exists) problems.push(`Missing ${kind}: ${relative}`);
    });
  };
  const checks: Promise<unknown>[] = [];
  for (const role of ['implementer', 'reviewer'] as const) {
    checks.push(declare(inventory.roles[role].entry, `entry prompt of the ${role} role`));
    for (const dependency of inventory.roles[role].dependencies) checks.push(declare(dependency.path, `dependency of the ${role} role`));
  }
  for (const shared of inventory.sharedResources) checks.push(declare(shared.path, 'shared resource'));
  for (const adaptation of inventory.adaptations) {
    checks.push(declare(adaptation.path, 'adapted resource'));
    checks.push(declare(adaptation.patch, 'patch of an adapted resource'));
  }
  await Promise.all(checks);
  const bundleFiles = await listMarkdownFiles(bundleRoot);
  for (const file of bundleFiles) {
    const relative = path.relative(root, file);
    if (!declared.has(relative)) problems.push(`Undeclared file in the bundle: ${relative}`);
    const links = markdownLinks(await readFile(file, 'utf8'));
    for (const link of links) {
      const target = path.resolve(path.dirname(file), link);
      if (path.relative(bundleRoot, target).startsWith('..')) problems.push(`Reference escapes the bundle: ${relative} -> ${link}`);
      else if (!(await fileExists(target))) problems.push(`Invalid reference: ${relative} -> ${link}`);
    }
  }
  return problems;
}

/** Inventaire lisible : provenance, rôles, dépendances, ressources partagées et adaptations. */
export function formatPromptsInventory(bundle: PromptsBundle): string {
  const { inventory } = bundle;
  const lines: string[] = [
    'Slopify prompts (read-only inspection of the versioned prompt bundle)',
    '',
    `Source: ${inventory.source.repository} @ ${inventory.source.commit}`,
    `Bundle: ${inventory.bundleRoot}/ (Slopify adaptations in patches/, pristine extraction in upstream/)`,
    '',
    'Roles:',
  ];
  for (const role of ['implementer', 'reviewer'] as const) {
    const definition = inventory.roles[role];
    lines.push(`- ${role}: ${definition.entry}`);
    lines.push(`  ${definition.summary}`);
    lines.push('  Dependencies:');
    if (definition.dependencies.length === 0) lines.push('  - none');
    for (const dependency of definition.dependencies) {
      const via = dependency.via ? ` (via ${dependency.via})` : '';
      const condition = dependency.condition ? ` — ${dependency.condition}` : '';
      lines.push(`  - ${dependency.path}${via}${condition}`);
    }
  }
  lines.push('', 'Shared resources:');
  for (const shared of inventory.sharedResources) lines.push(`- ${shared.path} — ${shared.note}`);
  lines.push('', 'Project-provided dependencies (resolved in the target project, not embedded):');
  for (const provided of inventory.projectProvided) lines.push(`- ${provided.reference} — ${provided.note}`);
  lines.push('', 'Slopify adaptations (upstream -> delivered):');
  for (const adaptation of inventory.adaptations) lines.push(`- ${adaptation.path} (${adaptation.patch}) — ${adaptation.summary}`);
  lines.push(
    '',
    'Print an exact entry prompt with: slopify prompts <implementer|reviewer>',
    'Print any bundled resource with: slopify prompts <path under the bundle>',
    'Verify declared resources and references with: slopify prompts --check',
  );
  return lines.join('\n');
}

interface PromptsCliDependencies { root?: string }

/** Commande `slopify prompts` : lecture seule, aucun secret ni valeur propre à un run. */
export async function runPromptsCli(argv: string[], terminal: { write(message: string): void; writeError(message: string): void }, dependencies: PromptsCliDependencies = {}): Promise<number> {
  try {
    const bundle = await loadPromptsBundle(dependencies.root ?? promptsPackageRoot());
    const [argument] = argv;
    if (argv.length === 0) {
      terminal.write(formatPromptsInventory(bundle));
      return 0;
    }
    if (argument === '--help' || argument === '-h') {
      terminal.write(promptsHelp);
      return 0;
    }
    if (argument === '--check') {
      const problems = await checkPromptsBundle(bundle);
      if (problems.length > 0) {
        for (const problem of problems) terminal.writeError(problem);
        terminal.writeError(`Prompts bundle check failed with ${problems.length} problem(s).`);
        return 1;
      }
      terminal.write('Prompts bundle check passed: declared resources exist, every bundle file is declared and internal references resolve.');
      return 0;
    }
    if (argv.length > 1) throw new Error('slopify prompts takes at most one argument. See slopify prompts --help.');
    const role = argument as keyof PromptsInventory['roles'];
    let relative: string;
    if (role in bundle.inventory.roles) relative = bundle.inventory.roles[role].entry;
    else {
      const candidate = path.resolve(bundle.root, argument);
      if (path.relative(bundle.root, candidate).startsWith('..')) throw new Error(`Refusing to read outside the prompts bundle: ${argument}`);
      relative = path.relative(bundle.root, candidate);
    }
    const target = path.join(bundle.root, relative);
    if (!(await fileExists(target))) {
      const available = (Object.keys(bundle.inventory.roles) as string[]).join(', ');
      throw new Error(`Unknown prompts role or resource: ${argument}. Use a role (${available}) or a path under the bundle. See slopify prompts --help.`);
    }
    const content = await readFile(target, 'utf8');
    terminal.write(content.endsWith('\n') ? content.slice(0, -1) : content);
    return 0;
  } catch (error: unknown) {
    terminal.writeError(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
