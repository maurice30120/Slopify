import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { resolveWorkflowResources } from '../src/index.js';

/**
 * Bundle de test minimal, conforme à la forme livrée par #184 :
 * inventory.json déclare les rôles et leurs dépendances transitIVES (avec `via`),
 * les fichiers restent lisibles depuis n'importe quel répertoire courant.
 */
async function bundle(t: { after(fn: () => Promise<void>): void }, rolesJson?: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-workflows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'skills/engineering/implement'), { recursive: true });
  await mkdir(path.join(root, 'skills/engineering/code-review'), { recursive: true });
  await mkdir(path.join(root, 'skills/engineering/tdd'), { recursive: true });
  await writeFile(path.join(root, 'skills/engineering/implement/SKILL.md'), 'implementation');
  await writeFile(path.join(root, 'skills/engineering/code-review/SKILL.md'), 'review');
  await writeFile(path.join(root, 'skills/engineering/tdd/SKILL.md'), 'tdd');
  await writeFile(path.join(root, 'inventory.json'), rolesJson ?? JSON.stringify({ roles: {
    implementer: { entry: 'skills/engineering/implement/SKILL.md', dependencies: [{ path: 'skills/engineering/tdd/SKILL.md' }] },
    reviewer: { entry: 'skills/engineering/code-review/SKILL.md', dependencies: [] },
  } }));
  return root;
}

test('the distributed inventory resolves both role entries and rejects missing transitive dependencies', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-workflows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'skills/engineering/implement'), { recursive: true });
  await mkdir(path.join(root, 'skills/engineering/code-review'), { recursive: true });
  await writeFile(path.join(root, 'skills/engineering/implement/SKILL.md'), 'implementation');
  await writeFile(path.join(root, 'skills/engineering/code-review/SKILL.md'), 'review');
  await writeFile(path.join(root, 'inventory.json'), JSON.stringify({ roles: {
    implementer: { entry: 'skills/engineering/implement/SKILL.md', dependencies: [{ path: 'skills/engineering/tdd/SKILL.md' }] },
    reviewer: { entry: 'skills/engineering/code-review/SKILL.md', dependencies: [] },
  } }));
  await assert.rejects(resolveWorkflowResources(root), /tdd\/SKILL\.md/);
  await mkdir(path.join(root, 'skills/engineering/tdd'), { recursive: true });
  await writeFile(path.join(root, 'skills/engineering/tdd/SKILL.md'), 'tdd');
  const resources = await resolveWorkflowResources(root);
  assert.equal(resources.implementer, path.join(root, 'skills/engineering/implement/SKILL.md'));
  assert.equal(resources.reviewer, path.join(root, 'skills/engineering/code-review/SKILL.md'));
});

test('a missing or unreadable inventory is an explicit error naming the expected file', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-workflows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(resolveWorkflowResources(root), /inventory\.json/);
});

test('an inventory without both role entries is rejected without guessing', async t => {
  const root = await bundle(t, JSON.stringify({ roles: {
    implementer: { entry: 'skills/engineering/implement/SKILL.md', dependencies: [] },
  } }));
  await assert.rejects(resolveWorkflowResources(root), /reviewer/);
});

test('a missing reviewer entry resource is an explicit error naming the role and the path', async t => {
  const root = await bundle(t, JSON.stringify({ roles: {
    implementer: { entry: 'skills/engineering/implement/SKILL.md', dependencies: [{ path: 'skills/engineering/tdd/SKILL.md' }] },
    reviewer: { entry: 'skills/engineering/code-review/MISSING.md', dependencies: [] },
  } }));
  await assert.rejects(resolveWorkflowResources(root), /reviewer entry.*code-review\/MISSING\.md/);
});

test('a declared dependency outside the bundle root is rejected', async t => {
  const root = await bundle(t, JSON.stringify({ roles: {
    implementer: { entry: 'skills/engineering/implement/SKILL.md', dependencies: [{ path: '../../etc/passwd' }] },
    reviewer: { entry: 'skills/engineering/code-review/SKILL.md', dependencies: [] },
  } }));
  await assert.rejects(resolveWorkflowResources(root), /outside the distributed bundle|escapes/i);
});

test('a transitive dependency whose via is not a declared resource of the role is rejected', async t => {
  const root = await bundle(t, JSON.stringify({ roles: {
    implementer: { entry: 'skills/engineering/implement/SKILL.md', dependencies: [{ path: 'skills/engineering/tdd/SKILL.md', via: 'skills/engineering/codebase-design/SKILL.md' }] },
    reviewer: { entry: 'skills/engineering/code-review/SKILL.md', dependencies: [] },
  } }));
  await assert.rejects(resolveWorkflowResources(root), /via.*codebase-design\/SKILL\.md/);
});

test('a broken internal markdown reference inside a resolved resource is an explicit error', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-workflows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'skills/engineering/implement'), { recursive: true });
  await mkdir(path.join(root, 'skills/engineering/code-review'), { recursive: true });
  await writeFile(path.join(root, 'skills/engineering/implement/SKILL.md'), 'Read [tdd](../tdd/SKILL.md).');
  await writeFile(path.join(root, 'skills/engineering/code-review/SKILL.md'), 'review');
  await writeFile(path.join(root, 'inventory.json'), JSON.stringify({ roles: {
    implementer: { entry: 'skills/engineering/implement/SKILL.md', dependencies: [] },
    reviewer: { entry: 'skills/engineering/code-review/SKILL.md', dependencies: [] },
  } }));
  await assert.rejects(resolveWorkflowResources(root), /implement\/SKILL\.md.*tdd\/SKILL\.md/);
});

test('resolution returns the transitive dependencies and the shared skills directory of the roles', async t => {
  const root = await bundle(t, JSON.stringify({ roles: {
    implementer: { entry: 'skills/engineering/implement/SKILL.md', dependencies: [
      { path: 'skills/engineering/tdd/SKILL.md' },
      { path: 'skills/engineering/tdd/tests.md', via: 'skills/engineering/tdd/SKILL.md' },
      { path: 'skills/engineering/code-review/SKILL.md', via: 'skills/engineering/tdd/SKILL.md' },
    ] },
    reviewer: { entry: 'skills/engineering/code-review/SKILL.md', dependencies: [] },
  } }));
  await writeFile(path.join(root, 'skills/engineering/tdd/tests.md'), 'tdd tests');
  const resources = await resolveWorkflowResources(root);
  assert.deepEqual(resources.roles.implementer.dependencies, [
    path.join(root, 'skills/engineering/tdd/SKILL.md'),
    path.join(root, 'skills/engineering/tdd/tests.md'),
    path.join(root, 'skills/engineering/code-review/SKILL.md'),
  ]);
  assert.deepEqual(resources.roles.reviewer.dependencies, []);
  assert.equal(resources.skillsDirectory, path.join(root, 'skills/engineering'));
  assert.equal(resources.root, root);
});
