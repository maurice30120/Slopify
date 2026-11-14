import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';
import { resolveWorkflowResources } from '@slopify/execution';
import { promptsPackageRoot } from '../src/prompts.js';

test('the shipped prompt distribution resolves both roles with their transitive dependencies', async () => {
  const root = promptsPackageRoot();
  const resources = await resolveWorkflowResources(root);
  assert.equal(resources.implementer, path.join(root, 'skills', 'engineering', 'implement', 'SKILL.md'));
  assert.equal(resources.reviewer, path.join(root, 'skills', 'engineering', 'code-review', 'SKILL.md'));
  assert.equal(resources.skillsDirectory, path.join(root, 'skills', 'engineering'));
  const dependencies = resources.roles.implementer.dependencies;
  assert.ok(dependencies.some(dependency => dependency.endsWith(path.join('tdd', 'SKILL.md'))));
  assert.ok(dependencies.some(dependency => dependency.endsWith(path.join('tdd', 'tests.md'))));
  assert.ok(dependencies.some(dependency => dependency.endsWith(path.join('tdd', 'mocking.md'))));
  assert.ok(dependencies.some(dependency => dependency.endsWith(path.join('codebase-design', 'SKILL.md'))));
  assert.ok(dependencies.some(dependency => dependency.endsWith(path.join('code-review', 'SKILL.md'))));
  assert.deepEqual(resources.roles.reviewer.dependencies, []);
  // Aucune copie concurrente hors du bundle livré : toutes les ressources restent dans la distribution.
  for (const file of [resources.implementer, resources.reviewer, ...dependencies]) {
    assert.ok(file.startsWith(root), `${file} must stay inside the shipped distribution`);
  }
});
