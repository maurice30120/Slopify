// Real Pi/Codex Docker smoke. Build first; prerequisites are the same as tasks run.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = await mkdtemp('/private/tmp/slopify-v2-docker-');
const repo = path.join(root, 'repo');
await mkdir(repo);
const gitRaw = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
const git = (...args) => gitRaw(...args).trim();
git('init', '-q'); git('config', 'user.name', 'Slopify Smoke'); git('config', 'user.email', 'smoke@localhost');
await writeFile(path.join(repo, 'README.md'), '# Docker smoke repository\n');
await writeFile(path.join(repo, 'AGENTS.md'), '# Standards\nUse UTF-8 text. Scope changes to the requested file. For documentation-only edits verify exact file contents; no application build is available.\n');
git('add', '.'); git('commit', '-qm', 'smoke base');
const head = git('rev-parse', 'HEAD');
await writeFile(path.join(root, 'spec.md'), '# Approved specification\nAdd pi.txt containing pi\n and codex.txt containing codex\n. Each file ends with one newline. No other product files change.\n');
const tasks = ['pi', 'codex'].map(agent => ({
  id: agent, agent, dependsOn: [], source: `${agent}.md`,
  prompt: `Use the installed implement skill for this approved documentation-only task. Create only ${agent}.txt with exactly "${agent}" and one newline. Check the exact contents, review your change against the frozen specification and repository standards, commit and report factual validation. The other agent creates its own separate file.`,
}));
await writeFile(path.join(root, 'batch.json'), JSON.stringify({ specFile: 'spec.md', tasks }, null, 2));
console.log(`Docker smoke evidence: ${root}`);
const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
const result = spawnSync(process.execPath, [cli, 'tasks', 'run', path.join(root, 'batch.json'), '--cwd', repo, '--store', path.join(root, 'runs'), '--json'], { encoding: 'utf8', timeout: 600000 });
await writeFile(path.join(root, 'cli.stdout'), result.stdout ?? '');
await writeFile(path.join(root, 'cli.stderr'), result.stderr ?? '');
const state = JSON.parse(result.stdout || '{}');
console.log(JSON.stringify({ exitCode: result.status, error: result.error?.message, runId: state.runId, status: state.status,
  tasks: state.tasks?.map(task => ({ id: task.id, status: task.status, diagnostics: task.attempts.at(-1)?.diagnostics })) }, null, 2));
assert.equal(result.status, 0, 'Docker smoke must succeed; inspect persisted evidence for failure');
assert.equal(state.status, 'succeeded');
assert.equal(state.tasks[0].attempts[0].taskBaseCommit, head);
assert.equal(state.tasks[1].attempts[0].taskBaseCommit, head);
for (const agent of ['pi', 'codex']) assert.equal(gitRaw('show', `${state.integrationBranch}:${agent}.txt`), agent + '\n');
assert.equal(git('rev-parse', 'HEAD'), head);
assert.equal(git('status', '--porcelain'), '');
assert.ok(state.tasks.every(task => task.attempts[0].resourceState === 'removed'));
assert.ok(state.tasks.every(task => task.attempts[0].checkpoint?.commit));
for (const task of state.tasks) assert.ok((await readFile(task.attempts[0].reportPath, 'utf8')).length > 0);
console.log('Mixed Pi/Codex Docker wave passed.');
