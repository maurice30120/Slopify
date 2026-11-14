import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';

/** Dépendance transitive déclarée par l'inventaire du bundle de workflows. */
export interface WorkflowResourceDependency {
  path: string;
  condition?: string;
  /** Fichier du bundle qui déclare ou transmet la dépendance. */
  via?: string;
}

/** Rôle (implémenteur ou reviewer) déclaré par l'inventaire du bundle de workflows. */
export interface WorkflowResourceRole {
  entry: string;
  dependencies?: WorkflowResourceDependency[];
}

/** Ressources résolues d'un rôle : entrée et dépendances transitives, en chemins absolus. */
export interface WorkflowRoleResources {
  entry: string;
  dependencies: string[];
}

/** Inventaire du bundle de workflows ; seuls les champs utiles à la résolution sont requis. */
export interface WorkflowResourcesInventory {
  roles: { implementer: WorkflowResourceRole; reviewer: WorkflowResourceRole };
}

/** Ressources de workflow de la distribution, prêtes à être consommées par un agent. */
export interface WorkflowResources {
  /** Racine du bundle (répertoire contenant inventory.json). */
  root: string;
  /** Inventaire lu, pour les diagnostics de provenance. */
  inventoryPath: string;
  /** Chemins absolus des prompts d'entrée, pour les consommateurs du contrat public. */
  implementer: string;
  reviewer: string;
  /** Répertoire des skills partagé par les rôles : point d'entrée --skill du runner. */
  skillsDirectory: string;
  /** Ressources complètes par rôle. */
  roles: { implementer: WorkflowRoleResources; reviewer: WorkflowRoleResources };
}

/** Liens Markdown internes `[label](target.md)` d'une ressource du bundle. */
function markdownLinks(content: string): string[] {
  return [...content.matchAll(/\]\(([^)#\s]+\.md)\)/g)].map(match => match[1]);
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/** Résout un chemin relatif du bundle en chemin absolu, sans permettre de sortir du bundle. */
function bundlePath(root: string, relative: string, kind: string): string {
  const resolved = path.resolve(root, relative);
  if (path.relative(root, resolved).startsWith('..')) {
    throw new Error(`${kind} escapes the distributed bundle: ${relative}`);
  }
  return resolved;
}

async function requireFile(candidate: string, missing: string): Promise<void> {
  if (!(await fileExists(candidate))) throw new Error(missing);
}

/**
 * Résout les ressources de workflow de la distribution depuis l'inventaire du bundle
 * (répertoire contenant inventory.json, livré avec la CLI). Valide les rôles, les
 * dépendances transitives et leurs références internes ; toute ressource manquante
 * ou référence invalide produit une erreur explicite, sans lecture du store global
 * des skills ni substitution silencieuse.
 */
export async function resolveWorkflowResources(root: string): Promise<WorkflowResources> {
  const inventoryPath = path.join(root, 'inventory.json');
  let inventory: unknown;
  try {
    inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  } catch (error: unknown) {
    throw new Error(`Cannot read the workflow resources inventory at ${inventoryPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const declaredRoles = (inventory as WorkflowResourcesInventory | undefined)?.roles;
  for (const role of ['implementer', 'reviewer'] as const) {
    if (typeof declaredRoles?.[role]?.entry !== 'string') {
      throw new Error(`Invalid workflow resources inventory at ${inventoryPath}: the ${role} role with an entry is required.`);
    }
  }
  const roles = declaredRoles as WorkflowResourcesInventory['roles'];
  const resolvedRoles: { implementer: WorkflowRoleResources; reviewer: WorkflowRoleResources } = {
    implementer: { entry: '', dependencies: [] },
    reviewer: { entry: '', dependencies: [] },
  };
  for (const role of ['implementer', 'reviewer'] as const) {
    const declared = roles[role];
    const entry = bundlePath(root, declared.entry, `The entry of the ${role} role`);
    await requireFile(entry, `Missing ${role} entry workflow resource in the distributed bundle: ${declared.entry}`);
    const dependencies: string[] = [];
    const declaredDependencies = declared.dependencies ?? [];
    for (const dependency of declaredDependencies) {
      if (typeof dependency?.path !== 'string') throw new Error(`Invalid dependency declaration of the ${role} role: ${JSON.stringify(dependency)}`);
      const resolved = bundlePath(root, dependency.path, `A dependency of the ${role} role`);
      await requireFile(resolved, `Missing ${role} dependency workflow resource in the distributed bundle: ${dependency.path}`);
      dependencies.push(resolved);
    }
    for (const dependency of declaredDependencies) {
      if (typeof dependency.via !== 'string') continue;
      const via = bundlePath(root, dependency.via, `The via reference of ${dependency.path}`);
      if (via !== entry && !dependencies.includes(via)) {
        throw new Error(`Invalid internal reference in the ${role} role: ${dependency.path} is declared via ${dependency.via}, which the inventory does not declare as a resource of the role.`);
      }
    }
    for (const file of [entry, ...dependencies]) {
      const relative = path.relative(root, file);
      const links = markdownLinks(await readFile(file, 'utf8'));
      for (const link of links) {
        const target = path.resolve(path.dirname(file), link);
        if (path.relative(root, target).startsWith('..')) {
          throw new Error(`Invalid internal reference: ${relative} -> ${link} escapes the distributed bundle.`);
        }
        await requireFile(target, `Missing referenced workflow resource in the distributed bundle: ${relative} -> ${link}`);
      }
    }
    resolvedRoles[role] = { entry, dependencies };
  }
  const directories = [...Object.values(resolvedRoles).flatMap(role => [path.dirname(role.entry), ...role.dependencies.map(path.dirname)])];
  const skillsDirectory = directories.reduce((common, directory) => commonPrefix(common, directory), directories[0]!);
  return {
    root,
    inventoryPath,
    implementer: resolvedRoles.implementer.entry,
    reviewer: resolvedRoles.reviewer.entry,
    skillsDirectory,
    roles: resolvedRoles,
  };
}

/** Longest common directory of two paths, aligned on a path separator boundary. */
function commonPrefix(left: string, right: string): string {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  let common = left.slice(0, index);
  if (common !== left) {
    const separator = common.lastIndexOf(path.sep);
    common = separator > 0 ? common.slice(0, separator) : common === path.sep ? path.sep : '';
  }
  return common;
}
