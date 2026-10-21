import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createNodeSubprocessExecutor } from '@slopify/execution';
import { GitOperations } from '../src/index.js';

function git(repo: string, ...args: string[]) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim(); }

test('createAgentCheckpoint freezes a private clone on a private ref without touching the host', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'host');
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(repo, 'base.txt'), 'committed base');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  // Le workspace utilisateur reste sale : il ne doit jamais être touché.
  await writeFile(path.join(repo, 'dirty.txt'), 'user change');
  const operations = new GitOperations({ executor: createNodeSubprocessExecutor() });
  const result = await operations.createAgentCheckpoint({
    workspaceCwd: repo, sandboxName: 'sbx-1', baseCommit: base,
    runId: 'run-1', taskId: 'work', attemptId: 'attempt-1',
  });
  assert.equal(result.checkpointStatus, 'checkpointed');
  assert.equal(result.preview.fileCount, 1);
  assert.ok(result.checkpoint.commit);
  assert.equal(git(repo, 'rev-parse', result.checkpoint.ref), result.checkpoint.commit);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), result.checkpoint.commit, 'the checkpoint commit is the clone HEAD');
  // Le checkpoint descend de la base épinglée et porte les métadonnées de la tentative.
  const messages = git(repo, 'log', '--format=%B', `${base}..${result.checkpoint.commit}`);
  assert.match(messages, /Slopify-Task: work/);
  assert.match(messages, /Slopify-Attempt: attempt-1/);
});

test('a clone without changes checkpoints as no_changes with an empty commit', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'host');
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(repo, 'base.txt'), 'base');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const operations = new GitOperations({ executor: createNodeSubprocessExecutor() });
  const result = await operations.createAgentCheckpoint({
    workspaceCwd: repo, sandboxName: 'sbx-2', baseCommit: base,
    runId: 'run-2', taskId: 'idle', attemptId: 'attempt-2',
  });
  assert.equal(result.checkpointStatus, 'no_changes');
  assert.equal(result.preview.fileCount, 0);
  assert.equal(result.preview.diff, '');
});
