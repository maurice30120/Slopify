#!/usr/bin/env node
// V2 package boundary and artifact audit. No network, provider or Docker required.
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageDirs = (await readdir(path.join(root, 'packages'), { withFileTypes: true }))
  .filter(entry => entry.isDirectory()).map(entry => path.join('packages', entry.name));
const directories = [...packageDirs, 'apps/cli'];
const packages = new Map();
for (const dir of directories) {
  const manifest = JSON.parse(await readFile(path.join(root, dir, 'package.json'), 'utf8'));
  if (!manifest.name || packages.has(manifest.name)) throw new Error('Missing/duplicate package name: ' + dir);
  packages.set(manifest.name, { dir, manifest });
}
const expected = ['@slopify/execution', '@slopify/git', '@slopify/activity', '@slopify/agent-codex',
  '@slopify/agent-pi', '@slopify/execution-sandbox', '@slopify/execution-local',
  '@slopify/task-batches', '@slopify/project-init', 'slopify'];
for (const name of expected) if (!packages.has(name)) throw new Error('Missing V2 workspace: ' + name);
if (packages.size !== expected.length) throw new Error('Unexpected workspace: ' + [...packages.keys()].join(', '));
const graph = new Map();
for (const [name, { dir, manifest }] of packages) {
  const deps = Object.keys(manifest.dependencies ?? {}).filter(dep => packages.has(dep));
  graph.set(name, deps);
  if (!manifest.exports?.['.']) throw new Error('Missing public export for ' + name);
  const artifact = name === 'slopify' ? 'dist/src/cli.js' : 'dist/src/index.js';
  const info = await stat(path.join(root, dir, artifact)).catch(() => undefined);
  if (!info?.isFile()) throw new Error('Missing built entrypoint: ' + dir + '/' + artifact);
  if (name === 'slopify' && manifest.bin?.slopify !== './dist/src/cli.js') throw new Error('CLI bin mismatch');
}
if ((packages.get('@slopify/task-batches').manifest.dependencies ?? {})['@slopify/execution-local']
  || (packages.get('@slopify/task-batches').manifest.dependencies ?? {})['@slopify/execution-sandbox']) {
  throw new Error('task-batches has a production dependency on a concrete executor');
}
const visited = new Set();
const active = new Set();
const visit = (name, chain = []) => {
  if (active.has(name)) throw new Error('Workspace dependency cycle: ' + [...chain, name].join(' -> '));
  if (visited.has(name)) return;
  active.add(name);
  for (const dep of graph.get(name) ?? []) visit(dep, [...chain, name]);
  active.delete(name); visited.add(name);
};
for (const name of packages.keys()) visit(name);
async function scan(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const loc = path.join(dir, entry.name);
    if (entry.isDirectory()) await scan(loc);
    else if (/\.ts$/u.test(entry.name)) {
      const source = await readFile(loc, 'utf8');
      if (/from ['"]@slopify\/[\w-]+\/(?:src|dist)\//u.test(source)) throw new Error('Private cross-workspace import: ' + loc);
    }
  }
}
for (const { dir } of packages.values()) await scan(path.join(root, dir, 'src'));
console.log('V2 architecture audit passed: 10 workspaces, public exports, no production cycles or private imports.');
