#!/usr/bin/env node
/**
 * Manual, real Pi/Codex smoke against an isolated temporary Git repository.
 * NOT part of npm test or CI. Requires provider access; sandbox mode needs sbx.
 * Keeps the temporary directory as evidence on both success and failure.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const mode = process.argv[2];
if (mode !== 'local' && mode !== 'sandbox') {
  console.error('Usage: node scripts/smoke-v2.mjs <local|sandbox>');
  process.exit(1);
}

const root = await mkdtemp(path.join(tmpdir(), `slopify-v2-${mode}-smoke-`));
const repo = path.join(root, 'repo');
await mkdir(repo);
const gitRaw = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
const git = (...args) => gitRaw(...args).trim();
git('init', '-q');
git('config', 'user.name', 'Slopify Smoke');
git('config', 'user.email', 'smoke@localhost');
await writeFile(path.join(repo, 'README.md'), '# Temporary smoke repository\n');
await writeFile(path.join(repo, 'AGENTS.md'), '# Standards\nOnly modify the requested file. Verify exact text contents.\n');
git('add', '.');
git('commit', '-qm', 'smoke base');
const head = git('rev-parse', 'HEAD');

await writeFile(path.join(root, 'spec.md'), '# Approved smoke specification\nCreate pi.txt containing pi\\n and codex.txt containing codex\\n. No other product files change.\n');
const tasks = ['pi', 'codex'].map(agent => ({
  id: agent,
  agent,
  dependsOn: [],
  source: `${agent}.md`,
  prompt: `Use the installed implement skill. Create only ${agent}.txt containing precisely "${agent}" followed by one newline. Verify the file contents, commit, review, and report the validation factually. The other agent writes a different file.`,
}));
await writeFile(path.join(root, 'batch.json'), JSON.stringify({ specFile: 'spec.md', tasks }, null, 2));

console.log(`Manual ${mode} smoke evidence: ${root}`);
const cli = fileURLToPath(new URL('../apps/cli/dist/src/cli.js', import.meta.url));
const result = spawnSync(process.execPath, [
  cli, 'tasks', 'run', path.join(root, 'batch.json'),
  '--mode', mode, '--cwd', repo, '--store', path.join(root, 'runs'), '--json',
], { encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
await writeFile(path.join(root, 'cli.stdout'), result.stdout ?? '');
await writeFile(path.join(root, 'cli.stderr'), result.stderr ?? '');
if (result.error) throw result.error;
let state;
try { state = JSON.parse(result.stdout || '{}'); }
catch { throw new Error(`Invalid CLI JSON; see ${root}/cli.stdout and cli.stderr`); }
console.log(JSON.stringify({
  mode,
  exitCode: result.status,
  runId: state.runId,
  status: state.status,
  tasks: state.tasks?.map(task => ({ id: task.id, status: task.status, diagnostics: task.attempts.at(-1)?.diagnostics })),
}, null, 2));

assert.equal(result.status, 0, `Smoke failed: inspect logs and persisted evidence under ${root}`);
assert.equal(state.status, 'succeeded');
assert.equal(state.mode, mode);
for (const agent of ['pi', 'codex']) assert.equal(gitRaw('show', `${state.integrationBranch}:${agent}.txt`), agent + '\n');
assert.equal(git('rev-parse', 'HEAD'), head);
assert.equal(git('status', '--porcelain'), '');
assert.ok(state.tasks.every(task => task.attempts[0]?.checkpoint?.commit));
assert.ok(state.tasks.every(task => task.attempts[0]?.resourceState === 'removed'));
for (const task of state.tasks) assert.ok((await readFile(task.attempts[0].reportPath, 'utf8')).length > 0);
console.log(`Mixed Pi/Codex ${mode} smoke passed. Evidence: ${root}`);
