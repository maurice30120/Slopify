import * as path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

const ENV_DENYLIST = new Set([
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
  'NODE_PATH',
]);

export function validatePath(filePath: string, workspaceRoot: string): string {
  const rootPath = path.resolve(workspaceRoot);
  const resolvedPath = path.resolve(rootPath, filePath);

  // Le contrôle lexical bloque `..` et les chemins absolus avant tout accès au
  // disque. Il ne suffit toutefois pas contre un lien symbolique déjà présent.
  if (!isWithinRoot(rootPath, resolvedPath)) {
    throw new Error(`Path escapes workspace boundary: ${filePath}`);
  }

  const rootRealPath = realpathSync(rootPath);
  // La cible peut ne pas exister lors d'une écriture. On résout donc son ancêtre
  // existant le plus proche pour détecter aussi les sorties via lien symbolique.
  const existingPath = findExistingAncestor(resolvedPath);
  const existingRealPath = realpathSync(existingPath);
  if (!isWithinRoot(rootRealPath, existingRealPath)) {
    throw new Error(`Path escapes workspace boundary: ${filePath}`);
  }

  return existsSync(resolvedPath) ? realpathSync(resolvedPath) : resolvedPath;
}

export function filterEnv(agentEnv: Record<string, string>): Record<string, string> {
  // Ces variables peuvent détourner le chargeur dynamique, Node ou la résolution
  // des exécutables avant même l'application des permissions ACP. La comparaison
  // reste insensible à la casse pour conserver le même garde-fou sur Windows.
  return Object.fromEntries(
    Object.entries(agentEnv).filter(([key]) => !ENV_DENYLIST.has(key.toUpperCase())),
  );
}

function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function findExistingAncestor(targetPath: string): string {
  let currentPath = targetPath;

  while (!existsSync(currentPath)) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }

  return currentPath;
}
