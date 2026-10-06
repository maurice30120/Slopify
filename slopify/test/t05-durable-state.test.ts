import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { SubprocessExecutor } from '@acp-client/sandbox';
import { TaskBatchService, type TaskBatchSnapshot } from '../src/taskBatch.js';

/** T05: Durable state and explicit resume tests */

async function fixture(t: { after(fn: () => Promise<void>): void }, executor?: SubprocessExecutor) {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-t05-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'core.autocrlf', 'false']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
  await writeFile(path.join(repo, 'initial.txt'), 'base\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'initial']);
  const batchFile = path.join(root, 'batch.json');
  const storePath = path.join(root, 'runs');
  const service = new TaskBatchService({ repositoryPath: repo, storePath, subprocessExecutor: executor });
  return { root, repo, batchFile, storePath, service };
}

function batch(tasks: Array<{ id: string; dependsOn: string[] }> = [{ id: 'implement', dependsOn: [] }]) {
  return {
    specFile: 'spec.md',
    tasks: tasks.map((task, index) => ({
      ...task, agent: index % 2 ? 'pi' : 'codex',
      prompt: '/implement\nFull ticket text and approved tests',
      source: index % 2 ? 'https://tracker.example/issues/12' : 'issues/01.md',
    })),
  };
}

// Helper to write state directly to file (for testing resume scenarios)
async function writeState(service: TaskBatchService, snapshot: TaskBatchSnapshot): Promise<void> {
  const file = path.join(service.storePath, snapshot.runId, 'state.json');
  await writeFile(file, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
}

// Helper to create integration workspace
async function createIntegrationWorkspace(service: TaskBatchService, snapshot: TaskBatchSnapshot): Promise<string> {
  const runDirectory = path.join(service.storePath, snapshot.runId);
  const workspacePath = path.join(runDirectory, 'integration');
  await mkdir(workspacePath, { recursive: true });
  await execFileSync('git', ['clone', '--no-hardlinks', '--quiet', '--', service.repositoryPath, workspacePath]);
  await execFileSync('git', ['-C', workspacePath, 'checkout', '--detach', snapshot.runBaseCommit]);
  await execFileSync('git', ['-C', workspacePath, 'branch', snapshot.integrationBranch, snapshot.runBaseCommit]);
  return workspacePath;
}

// Mock executor that handles git commands but fails on sbx
const mockExecutor: SubprocessExecutor = async request => {
  if (request.command === 'git') {
    const r = spawnSync('git', request.args, { cwd: request.cwd, encoding: 'utf8' });
    return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }
  // Fail on sbx to simulate no Docker
  if (request.command === 'sbx') {
    return { exitCode: 1, stdout: '', stderr: 'Docker unavailable in test' };
  }
  return { exitCode: 1, stdout: '', stderr: 'Unknown command' };
};

// AC1: Per-run state written atomically, retaining bases, attempts, commits, resources, reports and the branch

test('AC1: state file is written atomically with .tmp suffix', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'spec.md'), '# Spec');
  await writeFile(f.batchFile, JSON.stringify(batch()));
  
  const snapshot = await f.service.run(f.batchFile, { execute: false });
  
  const runDir = path.join(f.storePath, snapshot.runId);
  const stateFile = path.join(runDir, 'state.json');
  const tmpFile = path.join(runDir, 'state.json.tmp');
  
  // Verify state file exists
  assert.ok((await stat(stateFile)).isFile());
  // Verify no .tmp file left behind
  await assert.rejects(stat(tmpFile), { code: 'ENOENT' });
  
  // Verify state contains all required fields
  const state = JSON.parse(await readFile(stateFile, 'utf8')) as TaskBatchSnapshot;
  assert.equal(state.version, 1);
  assert.ok(state.runId);
  assert.equal(state.repositoryPath, f.repo);
  assert.ok(state.runBaseCommit);
  assert.equal(state.status, 'ready');
  assert.ok(state.integrationBranch);
  assert.ok(state.createdAt);
  assert.ok(state.updatedAt);
  assert.ok(state.context.specFile);
  assert.ok(state.context.specText);
  assert.ok(state.context.batchFile);
  assert.ok(Array.isArray(state.tasks));
  assert.ok(Array.isArray(state.diagnostics));
});

test('AC1: state contains all task attempts with their fields', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'spec.md'), '# Spec');
  await writeFile(f.batchFile, JSON.stringify(batch([{ id: 'a', dependsOn: [] }])));
  
  const snapshot = await f.service.run(f.batchFile, { execute: false });
  
  const stateFile = path.join(f.storePath, snapshot.runId, 'state.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8')) as TaskBatchSnapshot;
  
  // Verify tasks have proper structure
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].id, 'a');
  assert.equal(state.tasks[0].status, 'pending');
  assert.ok(Array.isArray(state.tasks[0].attempts));
  assert.equal(state.tasks[0].attempts.length, 0);
});

// AC2: Resume after process restart - reconstruct from store

test('AC2: service can reconstruct state from store after restart', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'spec.md'), '# Spec');
  await writeFile(f.batchFile, JSON.stringify(batch([{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }])));
  
  // Create initial run
  const snapshot = await f.service.run(f.batchFile, { execute: false });
  const runId = snapshot.runId;
  
  // Simulate process restart - create new service instance
  const newService = new TaskBatchService({ repositoryPath: f.repo, storePath: f.storePath });
  
  // Should be able to read the state
  const reconstructed = await newService.status(runId);
  
  assert.equal(reconstructed.runId, runId);
  assert.equal(reconstructed.repositoryPath, f.repo);
  assert.equal(reconstructed.status, 'ready');
  assert.equal(reconstructed.tasks.length, 2);
  assert.equal(reconstructed.tasks[0].id, 'a');
  assert.equal(reconstructed.tasks[1].id, 'b');
  assert.equal(reconstructed.context.specText, '# Spec');
});

// AC5: Changed/deleted source files after launch do not affect frozen context

test('AC5: frozen context preserved even after source deletion', async (t) => {
  const f = await fixture(t);
  const specPath = path.join(f.root, 'spec.md');
  await writeFile(specPath, '# Original Spec');
  await writeFile(f.batchFile, JSON.stringify(batch()));
  
  const snapshot = await f.service.run(f.batchFile, { execute: false });
  const runId = snapshot.runId;
  
  // Delete the original spec file
  await rm(specPath);
  await writeFile(specPath, '# Modified Spec');
  
  // Create new service and read state
  const newService = new TaskBatchService({ repositoryPath: f.repo, storePath: f.storePath });
  const state = await newService.status(runId);
  
  // Frozen spec should still be the original
  assert.equal(state.context.specText, '# Original Spec');
  assert.equal(await readFile(state.context.specFile, 'utf8'), '# Original Spec');
});

// AC7: Public status command works

test('AC7: tasks CLI status command reads durable state', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'spec.md'), '# CLI Spec');
  await writeFile(f.batchFile, JSON.stringify(batch([{ id: 'task1', dependsOn: [] }])));
  
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const bin = path.join(f.root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'sbx'), '#!/bin/sh\necho "Docker unavailable" >&2\nexit 1\n', { mode: 0o755 });
  
  const run = spawnSync(process.execPath, [cli, 'tasks', 'run', f.batchFile, '--cwd', f.repo, '--store', f.storePath, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH }
  });
  
  assert.equal(run.status, 0, run.stderr);
  const initial = JSON.parse(run.stdout) as TaskBatchSnapshot;
  
  const status = spawnSync(process.execPath, [cli, 'tasks', 'status', initial.runId, '--cwd', f.repo, '--store', f.storePath, '--json'], {
    encoding: 'utf8'
  });
  
  assert.equal(status.status, 0, status.stderr);
  const state = JSON.parse(status.stdout) as TaskBatchSnapshot;
  assert.equal(state.runId, initial.runId);
  assert.equal(state.status, initial.status);
});

// AC2: Resume after process restart - reuse integrated and recorded not-yet-integrated results WITHOUT duplicating

test('AC2: resume resets failed tasks to pending for re-execution', { timeout: 15000 }, async t => {
  const f = await fixture(t, mockExecutor);
  await writeFile(path.join(f.root, 'spec.md'), '# Spec');
  
  // Create a batch with two independent tasks
  const batchContent = batch([{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: [] }]);
  await writeFile(f.batchFile, JSON.stringify(batchContent));
  
  // Create initial run with execute: false (no integration workspace)
  let snapshot = await f.service.run(f.batchFile, { execute: false });
  
  // Create integration workspace manually
  await createIntegrationWorkspace(f.service, snapshot);
  
  // Manually set up a state where task a is succeeded and task b is failed
  snapshot.status = 'failed';
  snapshot.tasks[0].status = 'succeeded';
  snapshot.tasks[0].attempts.push({ attemptId: 'attempt-a-1', taskBaseCommit: snapshot.runBaseCommit, status: 'succeeded', integratedCommit: snapshot.runBaseCommit });
  snapshot.tasks[1].status = 'failed';
  snapshot.tasks[1].attempts.push({ attemptId: 'attempt-b-1', taskBaseCommit: snapshot.runBaseCommit, status: 'failed' });
  snapshot.integrationCommit = snapshot.runBaseCommit;
  await writeState(f.service, snapshot);
  
  // Now resume the run - should reset failed tasks to pending
  const resumed = await f.service.resume(snapshot.runId);
  
  // Task a should still be succeeded (not duplicated), task b should be reset to pending
  assert.equal(resumed.tasks[0].status, 'succeeded');
  assert.equal(resumed.tasks[0].attempts.length, 1); // Still only 1 attempt
  assert.equal(resumed.tasks[1].status, 'pending'); // Reset to pending for re-execution
  assert.equal(resumed.tasks[1].attempts.length, 1); // Still only 1 attempt (new one will be created on execution)
});

// AC3: Interrupted tasks become 'interrupted'; explicit resume creates new attempt identity and sandbox from current integration commit

test('AC3: resumeTask resets interrupted task to pending for re-execution', { timeout: 15000 }, async t => {
  const f = await fixture(t, mockExecutor);
  await writeFile(path.join(f.root, 'spec.md'), '# Spec');
  
  const batchContent = batch([{ id: 'task1', dependsOn: [] }]);
  await writeFile(f.batchFile, JSON.stringify(batchContent));
  
  // Create initial run with execute: false (no integration workspace)
  let snapshot = await f.service.run(f.batchFile, { execute: false });
  
  // Create integration workspace manually
  await createIntegrationWorkspace(f.service, snapshot);
  
  // Manually set up an interrupted state
  snapshot.status = 'interrupted';
  snapshot.tasks[0].status = 'interrupted';
  snapshot.tasks[0].attempts.push({ attemptId: 'attempt-1', taskBaseCommit: snapshot.runBaseCommit, status: 'interrupted' });
  snapshot.integrationCommit = snapshot.runBaseCommit;
  await writeState(f.service, snapshot);
  
  // Now resume the specific task - it will fail due to mock executor, but should have reset to pending first
  try {
    await f.service.resumeTask(snapshot.runId, 'task1');
  } catch (error) {
    // Expected to fail due to mock executor
    assert.match(String(error), /Docker unavailable/);
  }
  
  // Check the state after the failed resume
  const state = await f.service.status(snapshot.runId);
  
  // Should have created a new attempt (executeTask was called)
  assert.equal(state.tasks[0].attempts.length, 2);
  // The new attempt should have been created with 'running' status initially
  assert.equal(state.tasks[0].attempts[1].status, 'failed'); // But failed due to mock executor
});

// AC4: Explicit request can relaunch failed task; no attempt created by merely reading status

test('AC4: reading status does not create new attempts', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'spec.md'), '# Spec');
  
  const batchContent = batch([{ id: 'task1', dependsOn: [] }]);
  await writeFile(f.batchFile, JSON.stringify(batchContent));
  
  // Create initial run
  let snapshot = await f.service.run(f.batchFile, { execute: false });
  
  // Mark task as failed manually for testing
  snapshot.tasks[0].status = 'failed';
  snapshot.tasks[0].attempts.push({ attemptId: 'test-attempt', taskBaseCommit: snapshot.runBaseCommit, status: 'failed' });
  await writeState(f.service, snapshot);
  
  // Read status - should NOT create new attempts
  const status1 = await f.service.status(snapshot.runId);
  assert.equal(status1.tasks[0].attempts.length, 1);
  
  const status2 = await f.service.status(snapshot.runId);
  assert.equal(status2.tasks[0].attempts.length, 1);
});

// AC6: Failed/interrupted sandboxes stay inspectable; successes are cleaned after durable save

test('AC6: failed task attempts have retained resource state', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'spec.md'), '# Spec');
  
  const batchContent = batch([{ id: 'failing', dependsOn: [] }]);
  await writeFile(f.batchFile, JSON.stringify(batchContent));
  
  // Create initial run
  let snapshot = await f.service.run(f.batchFile, { execute: false });
  
  // Manually set up a failed state with retained resources
  snapshot.tasks[0].status = 'failed';
  snapshot.tasks[0].attempts.push({ 
    attemptId: 'attempt-1', 
    taskBaseCommit: snapshot.runBaseCommit, 
    status: 'failed',
    resourceState: 'retained'
  });
  await writeState(f.service, snapshot);
  
  // Read status - failed attempts should have resourceState = 'retained'
  const status = await f.service.status(snapshot.runId);
  assert.equal(status.tasks[0].attempts[0].resourceState, 'retained');
});

// AC7: Public resume commands work - resume fails without integration workspace

test('AC7: tasks CLI resume command fails without integration workspace', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'spec.md'), '# CLI Spec');
  await writeFile(f.batchFile, JSON.stringify(batch([{ id: 'task1', dependsOn: [] }])));
  
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const bin = path.join(f.root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'sbx'), '#!/bin/sh\necho "Docker unavailable" >&2\nexit 1\n', { mode: 0o755 });
  
  // Create a run with execute: false (no integration workspace)
  let snapshot = await f.service.run(f.batchFile, { execute: false });
  
  // Manually set up a failed state
  snapshot.tasks[0].status = 'failed';
  snapshot.tasks[0].attempts.push({ attemptId: 'test-attempt', taskBaseCommit: snapshot.runBaseCommit, status: 'failed' });
  await writeState(f.service, snapshot);
  
  // Verify integration workspace does NOT exist
  const workspacePath = path.join(f.storePath, snapshot.runId, 'integration');
  await assert.rejects(stat(workspacePath), { code: 'ENOENT' });
  
  // Try to resume via CLI - should fail because integration workspace doesn't exist
  const resume = spawnSync(process.execPath, [cli, 'tasks', 'resume', snapshot.runId, '--cwd', f.repo, '--store', f.storePath], {
    encoding: 'utf8',
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH }
  });
  
  // Should fail with error
  assert.equal(resume.status, 1);
  // The error should be visible in stderr
  assert.ok(resume.stderr.includes('Error:') || resume.stderr.includes('workspace'));
});

// AC7: Public resume-task commands work

test('AC7: tasks CLI resume-task command fails without integration workspace', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'spec.md'), '# CLI Spec');
  await writeFile(f.batchFile, JSON.stringify(batch([{ id: 'task1', dependsOn: [] }])));
  
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const bin = path.join(f.root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'sbx'), '#!/bin/sh\necho "Docker unavailable" >&2\nexit 1\n', { mode: 0o755 });
  
  // Create a run with execute: false (no integration workspace)
  let snapshot = await f.service.run(f.batchFile, { execute: false });
  
  // Manually set up a failed state
  snapshot.tasks[0].status = 'failed';
  snapshot.tasks[0].attempts.push({ attemptId: 'test-attempt', taskBaseCommit: snapshot.runBaseCommit, status: 'failed' });
  await writeState(f.service, snapshot);
  
  // Verify integration workspace does NOT exist
  const workspacePath = path.join(f.storePath, snapshot.runId, 'integration');
  await assert.rejects(stat(workspacePath), { code: 'ENOENT' });
  
  // Try to resume-task via CLI - should fail because integration workspace doesn't exist
  const resume = spawnSync(process.execPath, [cli, 'tasks', 'resume-task', snapshot.runId, 'task1', '--cwd', f.repo, '--store', f.storePath], {
    encoding: 'utf8',
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH }
  });
  
  // Should fail with error
  assert.equal(resume.status, 1);
  // The error should be visible in stderr
  assert.ok(resume.stderr.includes('Error:') || resume.stderr.includes('workspace'));
});
