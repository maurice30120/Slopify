import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import type { SubprocessExecutor } from '@acp-client/sandbox';
import { TaskBatchService, type TaskBatchSnapshot } from '../src/taskBatch.js';

const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp('/private/tmp/slopify-checkpoint-resume-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'host');
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(repo, 'base.txt'), 'base'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  await writeFile(path.join(root, 'spec.md'), '# Spec');
  const batchFile = path.join(root, 'batch.json');
  await writeFile(batchFile, JSON.stringify({ specFile: 'spec.md', tasks: [{ id: 'work', agent: 'codex', dependsOn: [], source: 'work', prompt: 'work' }] }));
  const calls: string[][] = [];
  const execute: SubprocessExecutor = async request => {
    if (request.command === 'git') {
      const r = spawnSync('git', request.args, { cwd: request.cwd, encoding: 'utf8' });
      return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    calls.push(request.args);
    return { exitCode: 1, stdout: '', stderr: 'Docker deliberately unavailable' };
  };
  const storePath = path.join(root, 'runs');
  const service = new TaskBatchService({ repositoryPath: repo, storePath, subprocessExecutor: execute });
  const snapshot = await service.run(batchFile, { execute: false });
  delete snapshot.workerPoolConfig; delete snapshot.workers;
  const directory = path.join(storePath, snapshot.runId);
  const integration = path.join(directory, 'integration');
  execFileSync('git', ['clone', '-q', repo, integration]);
  git(integration, 'config', 'user.name', 'Test'); git(integration, 'config', 'user.email', 'test@example.invalid');
  git(integration, 'branch', snapshot.integrationBranch, snapshot.runBaseCommit);
  await writeFile(path.join(integration, 'result.txt'), 'checkpoint'); git(integration, 'add', '.'); git(integration, 'commit', '-qm', 'checkpoint');
  const commit = git(integration, 'rev-parse', 'HEAD');
  const attemptDirectory = path.join(directory, 'attempts', 'original');
  await mkdir(attemptDirectory, { recursive: true });
  const bundlePath = path.join(attemptDirectory, 'checkpoint.bundle');
  git(integration, 'bundle', 'create', bundlePath, 'HEAD');
  const reportPath = path.join(attemptDirectory, 'report.md'); await writeFile(reportPath, 'original evidence');
  snapshot.status = 'failed'; snapshot.integrationCommit = snapshot.runBaseCommit;
  snapshot.tasks[0].status = 'failed';
  snapshot.tasks[0].attempts = [{ attemptId: 'original', taskBaseCommit: snapshot.runBaseCommit, status: 'succeeded', exitCode: 0, checkpoint: { commit, bundlePath }, reportPath }];
  const save = (value: TaskBatchSnapshot = snapshot) => writeFile(path.join(directory, 'state.json'), JSON.stringify(value));
  await save();
  return { root, repo, directory, integration, commit, bundlePath, reportPath, attemptDirectory, service, snapshot, save, calls, execute, storePath };
}

test('targeted resume integrates a durable successful checkpoint without running a new agent', async t => {
  const f = await fixture(t);
  const state = await f.service.resumeTask(f.snapshot.runId, 'work');
  assert.equal(state.tasks[0].status, 'succeeded');
  assert.equal(state.tasks[0].attempts.length, 1);
  assert.equal(state.tasks[0].attempts[0].checkpointIntegrity?.status, 'valid');
  assert.equal(git(f.repo, 'show', `${state.integrationBranch}:result.txt`), 'checkpoint');
  assert.deepEqual(f.calls, []);
});
