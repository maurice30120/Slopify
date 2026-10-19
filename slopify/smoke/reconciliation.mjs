// Real Pi/Codex Docker smoke for the reconciliation POC — distinct from the deterministic tests
// and from the V2 smoke (task-batch.mjs). Build first; prerequisites are the same as tasks run
// plus `--review`: sbx with official skills, Pi and Codex images, Docker available.
// Run: node slopify/smoke/reconciliation.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'slopify-reconciliation-'));
const repo = path.join(root, 'repo');
await mkdir(repo);
const gitRaw = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
const git = (...args) => gitRaw(...args).trim();
git('init', '-q'); git('config', 'user.name', 'Slopify Smoke'); git('config', 'user.email', 'smoke@localhost');
await writeFile(path.join(repo, 'README.md'), '# Reconciliation smoke repository\n');
await writeFile(path.join(repo, 'AGENTS.md'), '# Standards\nUse UTF-8 text. Scope changes to the requested file. For documentation-only edits verify exact file contents; no application build is available.\n');
git('add', '.'); git('commit', '-qm', 'smoke base');
const head = git('rev-parse', 'HEAD');

// Miniature batch with a dependency graph: api first, then its consumer; an independent ticket in parallel.
await writeFile(path.join(root, 'spec.md'), '# Approved specification\nAdd api.txt containing api and one newline. Add client.txt containing client and one newline. Add standalone.txt containing standalone and one newline. No other product files change.\n');
const tasks = [
  { id: 'api', agent: 'pi', dependsOn: [], source: 'api.md',
    prompt: `Use the installed implement skill for this approved documentation-only task. Create only api.txt with exactly "api" and one newline. Check the exact contents, verify against the frozen specification and repository standards, commit and report factual validation.` },
  { id: 'standalone', agent: 'codex', dependsOn: [], source: 'standalone.md',
    prompt: `Use the installed implement skill for this approved documentation-only task. Create only standalone.txt with exactly "standalone" and one newline. Check the exact contents, verify against the frozen specification and repository standards, commit and report factual validation.` },
  { id: 'client', agent: 'pi', dependsOn: ['api'], source: 'client.md',
    prompt: `Use the installed implement skill for this approved documentation-only task. Create only client.txt with exactly "client" and one newline. Check the exact contents, verify against the frozen specification and repository standards, commit and report factual validation.` },
];
await writeFile(path.join(root, 'batch.json'), JSON.stringify({ specFile: 'spec.md', tasks }, null, 2));
console.log(`Reconciliation smoke evidence: ${root}`);

const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
const result = spawnSync(process.execPath, [cli, 'tasks', 'run', path.join(root, 'batch.json'),
  '--cwd', repo, '--store', path.join(root, 'runs'), '--review', '--json'],
{ encoding: 'utf8', timeout: 900000 });
await writeFile(path.join(root, 'cli.stdout'), result.stdout ?? '');
await writeFile(path.join(root, 'cli.stderr'), result.stderr ?? '');
const state = JSON.parse(result.stdout || '{}');
console.log(JSON.stringify({ exitCode: result.status, error: result.error?.message, runId: state.runId, status: state.status,
  tasks: state.tasks?.map(task => ({ id: task.id, status: task.status, phase: task.phase, corrections: task.corrections ?? 0 })) }, null, 2));

// The reconciliation gate: every ticket passed an independent review before integration.
assert.equal(result.status, 0, 'Reconciliation smoke must succeed; inspect persisted evidence for failure');
assert.equal(state.status, 'succeeded');
for (const task of state.tasks) {
  assert.equal(task.status, 'succeeded', `task ${task.id} must succeed`);
  if (task.id === 'final-review') continue;
  assert.equal(task.phase, 'accepted', `task ${task.id} must be accepted through the review gate`);
  assert.ok(Array.isArray(task.lastReview?.findings), `task ${task.id} must carry a structured review verdict`);
}
assert.ok(Array.isArray(state.decisions) && state.decisions.length >= 3, 'the decision journal must be durable');
const client = state.tasks.find(task => task.id === 'client');
const api = state.tasks.find(task => task.id === 'api');
assert.notEqual(client.attempts[0].taskBaseCommit, head, 'the dependent ticket builds on the integrated review-passed base');
assert.equal(api.attempts[0].taskBaseCommit, head, 'the root ticket starts from the run base');
for (const file of ['api.txt', 'client.txt', 'standalone.txt']) {
  assert.equal(gitRaw('show', `${state.integrationBranch}:${file}`).trim(), file.replace('.txt', ''));
}
assert.equal(git('rev-parse', 'HEAD'), head, 'the user worktree stays intact');
assert.equal(git('status', '--porcelain'), '', 'no uncommitted user change is touched');
console.log('Reconciliation smoke passed: every ticket was independently reviewed with proofs before integration.');
