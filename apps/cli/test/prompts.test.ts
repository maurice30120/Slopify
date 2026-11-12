import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  checkPromptsBundle,
  formatPromptsInventory,
  loadPromptsBundle,
  promptsPackageRoot,
  promptsHelp,
  runPromptsCli,
} from '../src/prompts.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

/** Terminal de capture qui reproduit l'ajout de fin de ligne du terminal réel. */
function captureTerminal() {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    write: (message: string) => output.push(`${message}\n`),
    writeError: (message: string) => errors.push(`${message}\n`),
  };
}

test('the package root exposes the versioned prompts bundle with an explicit inventory', async () => {
  const root = promptsPackageRoot();
  const bundle = await loadPromptsBundle(root);
  assert.equal(bundle.root, root);
  assert.equal(bundle.inventory.source.repository, 'https://github.com/mattpocock/skills');
  assert.match(bundle.inventory.source.commit, /^[0-9a-f]{40}$/);
  assert.equal(bundle.inventory.roles.implementer.entry, 'skills/engineering/implement/SKILL.md');
  assert.equal(bundle.inventory.roles.reviewer.entry, 'skills/engineering/code-review/SKILL.md');
});

test('the bundle check passes on the distributed resources', async () => {
  const bundle = await loadPromptsBundle();
  assert.deepEqual(await checkPromptsBundle(bundle), []);
});

test('every non-adapted bundle file stays byte-identical to the pristine upstream extraction', async () => {
  const bundle = await loadPromptsBundle();
  const adapted = new Set(bundle.inventory.adaptations.map(adaptation => adaptation.path));
  const entries = await readdir(path.join(bundle.root, bundle.inventory.bundleRoot), { withFileTypes: true, recursive: true });
  const bundleFiles = entries.filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(entry => path.join(entry.parentPath, entry.name));
  assert.ok(bundleFiles.length >= 8);
  for (const file of bundleFiles) {
    const relative = path.relative(bundle.root, file);
    const upstream = path.join(bundle.root, 'upstream', path.relative(path.join(bundle.root, bundle.inventory.bundleRoot), file));
    const delivered = await readFile(file, 'utf8');
    const pristine = await readFile(upstream, 'utf8');
    if (adapted.has(relative)) {
      assert.notEqual(delivered, pristine, `${relative} is declared adapted but matches upstream`);
      const adaptation = bundle.inventory.adaptations.find(candidate => candidate.path === relative);
      assert.ok(adaptation, `${relative} has an inventory entry`);
      assert.ok(await stat(path.join(bundle.root, adaptation.patch)).then(() => true, () => false), `${relative} has its patch`);
    } else {
      assert.equal(delivered, pristine, `${relative} must stay identical to upstream or be declared as adapted`);
    }
  }
});

test('the implementer entry keeps ticket resolution, TDD at seams, validations, commit-before-done and corrections', async () => {
  const bundle = await loadPromptsBundle();
  const entry = await readFile(path.join(bundle.root, bundle.inventory.roles.implementer.entry), 'utf8');
  assert.match(entry, /fetch it from the issue tracker and state its title before starting/);
  assert.match(entry, /pre-agreed seams/);
  assert.match(entry, /Run typechecking regularly, single test files regularly, and the full test suite once at the end/);
  assert.match(entry, /commit it to the current branch before reporting done/);
  assert.match(entry, /you also handle the corrections/);
  assert.doesNotMatch(entry, /call the Skill tool with "code-review"/);
  assert.match(entry, /Do not launch an independent review of your own work/);
});

test('the reviewer entry keeps the two-axis review, parallel sub-agents and aggregation, and reports findings only', async () => {
  const bundle = await loadPromptsBundle();
  const entry = await readFile(path.join(bundle.root, bundle.inventory.roles.reviewer.entry), 'utf8');
  assert.match(entry, /\*\*Standards\*\*/);
  assert.match(entry, /\*\*Spec\*\*/);
  assert.match(entry, /parallel sub-agents/i);
  assert.match(entry, /Do \*\*not\*\* merge or rerank findings/);
  assert.match(entry, /This review produces findings only: do not modify code and do not create commits/);
});

test('the prompts command displays exactly the distributed content for roles and dependencies', async () => {
  const bundle = await loadPromptsBundle();
  const terminal = captureTerminal();
  for (const role of ['implementer', 'reviewer'] as const) {
    const run = await runPromptsCli([role], terminal);
    assert.equal(run, 0);
    assert.deepEqual(terminal.output, [await readFile(path.join(bundle.root, bundle.inventory.roles[role].entry), 'utf8')]);
    terminal.output.length = 0;
  }
  const dependency = bundle.inventory.roles.implementer.dependencies[0].path;
  assert.equal(await runPromptsCli([dependency], terminal), 0);
  assert.deepEqual(terminal.output, [await readFile(path.join(bundle.root, dependency), 'utf8')]);
});

test('the prompts inventory lists provenance, roles, dependencies, shared resources and adaptations', async () => {
  const bundle = await loadPromptsBundle();
  const listing = formatPromptsInventory(bundle);
  assert.match(listing, new RegExp(bundle.inventory.source.commit));
  assert.match(listing, /- implementer: skills\/engineering\/implement\/SKILL\.md/);
  assert.match(listing, /- reviewer: skills\/engineering\/code-review\/SKILL\.md/);
  for (const dependency of bundle.inventory.roles.implementer.dependencies) assert.match(listing, new RegExp(dependency.path.replace(/\//g, '\\/')));
  assert.match(listing, /Shared resources:/);
  assert.match(listing, /Project-provided dependencies/);
  assert.match(listing, /Slopify adaptations/);
  const terminal = captureTerminal();
  assert.equal(await runPromptsCli([], terminal), 0);
  assert.equal(terminal.output[0], `${listing}\n`);
});

test('the prompts command rejects unknown roles, missing resources and paths outside the bundle', async () => {
  const terminal = captureTerminal();
  assert.equal(await runPromptsCli(['architect'], terminal), 1);
  assert.match(terminal.errors[0], /Unknown prompts role or resource: architect/);
  assert.match(terminal.errors[0], /implementer, reviewer/);
  terminal.errors.length = 0;
  assert.equal(await runPromptsCli(['skills/engineering/implement/absent.md'], terminal), 1);
  assert.match(terminal.errors[0], /Unknown prompts role or resource: skills\/engineering\/implement\/absent\.md/);
  terminal.errors.length = 0;
  assert.equal(await runPromptsCli(['../package.json'], terminal), 1);
  assert.match(terminal.errors[0], /Refusing to read outside the prompts bundle/);
  terminal.errors.length = 0;
  assert.equal(await runPromptsCli(['toString'], terminal), 1);
  assert.match(terminal.errors[0], /Unknown prompts role or resource: toString/);
  terminal.errors.length = 0;
  assert.equal(await runPromptsCli(['--check', 'extra'], terminal), 1);
  assert.match(terminal.errors[0], /takes at most one argument/);
  terminal.errors.length = 0;
  assert.equal(await runPromptsCli(['--help'], terminal), 0);
  assert.equal(terminal.output[0], `${promptsHelp}\n`);
});

test('the bundle check reports missing resources, invalid references and undeclared files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-prompts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'skills/entry'), { recursive: true });
  await mkdir(path.join(root, 'skills/reviewer'), { recursive: true });
  await writeFile(path.join(root, 'skills/entry/SKILL.md'), 'Read [gone](../gone.md).\n');
  await writeFile(path.join(root, 'skills/reviewer/SKILL.md'), 'Review.\n');
  await writeFile(path.join(root, 'skills/orphan.md'), 'Undeclared.\n');
  await writeFile(path.join(root, 'inventory.json'), JSON.stringify({
    version: 1,
    source: { repository: 'fixture', commit: '0'.repeat(40) },
    bundleRoot: 'skills',
    roles: {
      implementer: { entry: 'skills/entry/SKILL.md', summary: 's', dependencies: [{ path: 'skills/missing.md' }] },
      reviewer: { entry: 'skills/reviewer/SKILL.md', summary: 's', dependencies: [] },
    },
    sharedResources: [], projectProvided: [], adaptations: [],
  }));
  const bundle = await loadPromptsBundle(root);
  const problems = await checkPromptsBundle(bundle);
  assert.ok(problems.some(problem => problem.includes('Missing dependency of the implementer role: skills/missing.md')), problems.join('\n'));
  assert.ok(problems.some(problem => problem.includes('Invalid reference: skills/entry/SKILL.md -> ../gone.md')), problems.join('\n'));
  assert.ok(problems.some(problem => problem.includes('Undeclared file in the bundle: skills/orphan.md')), problems.join('\n'));
  const terminal = captureTerminal();
  assert.equal(await runPromptsCli(['--check'], terminal, { root }), 1);
  assert.ok(terminal.errors.some(error => error.includes('Prompts bundle check failed')));
});

test('a symlinked CLI displays the exact prompts from any working directory', { skip: process.platform === 'win32' }, async t => {
  const { mkdir, symlink, rm } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-prompts-symlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const project = path.join(root, 'project');
  await Promise.all([mkdir(bin), mkdir(project)]);
  const linkedCli = path.join(bin, 'slopify');
  await symlink(cli, linkedCli);
  const bundle = await loadPromptsBundle();
  const entry = await readFile(path.join(bundle.root, bundle.inventory.roles.implementer.entry), 'utf8');
  const shown = spawnSync(process.execPath, [linkedCli, 'prompts', 'implementer'], { cwd: project, encoding: 'utf8' });
  assert.equal(shown.status, 0, shown.stderr || shown.stdout);
  assert.equal(shown.stdout, entry);
  const checked = spawnSync(process.execPath, [linkedCli, 'prompts', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.match(checked.stdout, /Prompts bundle check passed/);
  const listed = spawnSync(process.execPath, [linkedCli, 'prompts'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  assert.match(listed.stdout, /- implementer: skills\/engineering\/implement\/SKILL\.md/);
  assert.match(listed.stdout, /- reviewer: skills\/engineering\/code-review\/SKILL\.md/);
});

test('the general help exposes the prompts command', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /slopify prompts/);
});
