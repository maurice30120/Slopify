import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { TaskBatchService, TaskBatchValidationError } from '../src/taskBatch.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-task-batch-'));
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
  const service = new TaskBatchService({ repositoryPath: repo, storePath });
  return { root, repo, batchFile, storePath, service };
}

test('invalid JSON is diagnosed without creating a run or changing the repository', async (t) => {
  const f = await fixture(t);
  await writeFile(f.batchFile, '{');
  const before = execFileSync('git', ['-C', f.repo, 'show-ref']).toString();
  await assert.rejects(f.service.run(f.batchFile), (error: unknown) => {
    assert.ok(error instanceof TaskBatchValidationError);
    assert.equal(error.diagnostics[0].code, 'invalid_json');
    return true;
  });
  await assert.rejects(readdir(f.storePath), { code: 'ENOENT' });
  assert.equal(execFileSync('git', ['-C', f.repo, 'show-ref']).toString(), before);
  assert.equal(execFileSync('git', ['-C', f.repo, 'status', '--porcelain']).toString(), '');
});

test('reports all malformed fields and task graph references before creating any run', async (t) => {
  const f = await fixture(t);
  await writeFile(f.batchFile, JSON.stringify({
    specFile: 12,
    tasks: [
      { id: 'a', prompt: '', dependsOn: ['a', 'missing'], agent: 'vibe' },
      { id: 'a', prompt: 3, dependsOn: 'a', agent: 'codex', source: '' },
    ],
  }));
  await assert.rejects(f.service.run(f.batchFile), (error: unknown) => {
    assert.ok(error instanceof TaskBatchValidationError);
    assert.deepEqual(new Set(error.diagnostics.map((d) => d.code)), new Set([
      'invalid_spec_file', 'invalid_prompt', 'invalid_dependencies', 'invalid_agent',
      'invalid_source', 'duplicate_id', 'self_dependency', 'missing_dependency',
    ]));
    assert.ok(error.diagnostics.every((d) => d.path));
    return true;
  });
  await assert.rejects(readdir(f.storePath), { code: 'ENOENT' });
});

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

test('a dependency cycle is refused with the participating task IDs', async (t) => {
  const f = await fixture(t);
  await writeFile(f.batchFile, JSON.stringify(batch([
    { id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['c'] }, { id: 'c', dependsOn: ['a'] },
  ])));
  await assert.rejects(f.service.run(f.batchFile), (error: unknown) => {
    assert.ok(error instanceof TaskBatchValidationError);
    assert.equal(error.diagnostics[0].code, 'dependency_cycle');
    assert.match(error.message, /a.*b.*c.*a/);
    return true;
  });
  await assert.rejects(readdir(f.storePath), { code: 'ENOENT' });
});

test('a missing specification prevents a valid task batch from creating a run', async (t) => {
  const f = await fixture(t);
  await writeFile(f.batchFile, JSON.stringify(batch()));
  await assert.rejects(f.service.run(f.batchFile), (error: unknown) => {
    assert.ok(error instanceof TaskBatchValidationError);
    assert.equal(error.diagnostics[0].code, 'unreadable_spec');
    assert.match(error.message, /spec\.md/);
    return true;
  });
  await assert.rejects(readdir(f.storePath), { code: 'ENOENT' });
});

test('a mixed-agent batch freezes its spec, prompts, references and chosen Git base for later status reads', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'spec.md'), '# Approved spec\nUse Pi and Codex.\n');
  const input = batch([{ id: 'codex-work', dependsOn: [] }, { id: 'pi-review', dependsOn: ['codex-work'] }]);
  input.tasks[1].prompt = '$implement\nDo not rewrite this invocation';
  await writeFile(f.batchFile, JSON.stringify(input));
  const baseCommit = execFileSync('git', ['-C', f.repo, 'rev-parse', 'HEAD']).toString().trim();
  await writeFile(path.join(f.repo, 'next.txt'), 'new committed base\n');
  execFileSync('git', ['-C', f.repo, 'add', '.']);
  execFileSync('git', ['-C', f.repo, 'commit', '-qm', 'next']);
  const hostHead = execFileSync('git', ['-C', f.repo, 'rev-parse', 'HEAD']).toString().trim();
  await writeFile(path.join(f.repo, 'initial.txt'), 'user changes\n');
  const snapshot = await f.service.run(f.batchFile, { baseRef: baseCommit });
  await rm(f.batchFile);
  await writeFile(path.join(f.root, 'spec.md'), '# Changed spec');
  const reopened = new TaskBatchService({ repositoryPath: f.repo, storePath: f.storePath });
  const state = await reopened.status(snapshot.runId);
  assert.equal(state.status, 'ready');
  assert.equal(state.runBaseCommit, baseCommit);
  assert.equal(state.context.specText, '# Approved spec\nUse Pi and Codex.\n');
  assert.equal(await readFile(state.context.specFile, 'utf8'), state.context.specText);
  assert.deepEqual(state.tasks.map(({ id, prompt, source, agent, dependsOn, status }) => ({ id, prompt, source, agent, dependsOn, status })),
    input.tasks.map((task) => ({ ...task, status: 'pending' })));
  assert.equal(await readFile(path.join(f.repo, 'initial.txt'), 'utf8'), 'user changes\n');
  assert.equal(execFileSync('git', ['-C', f.repo, 'rev-parse', 'HEAD']).toString().trim(), hostHead);
});

test('tasks CLI launches a frozen batch and reads its public status after source removal', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'spec.md'), '# CLI spec');
  await writeFile(f.batchFile, JSON.stringify(batch()));
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = spawnSync(process.execPath, [cli, 'tasks', 'run', f.batchFile, '--cwd', f.repo, '--store', f.storePath, '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const initial = JSON.parse(run.stdout);
  assert.equal(initial.status, 'ready');
  await rm(f.batchFile);
  const status = spawnSync(process.execPath, [cli, 'tasks', 'status', initial.runId, '--cwd', f.repo, '--store', f.storePath, '--json'], { encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).context.specText, '# CLI spec');
});

test('non-object batches, empty tasks and invalid task field types yield actionable diagnostics', async (t) => {
  const f = await fixture(t);
  for (const [input, expectedCode] of [
    [null, 'invalid_batch'],
    [[], 'invalid_batch'],
    [{ specFile: 'spec.md', tasks: [] }, 'invalid_tasks'],
    [{ specFile: 'spec.md', tasks: 'ticket' }, 'invalid_tasks'],
    [{ specFile: 'spec.md', tasks: [null] }, 'invalid_task'],
    [{ specFile: 'spec.md', tasks: [{ prompt: 'work', dependsOn: [], source: 'x', agent: 'pi' }] }, 'invalid_id'],
    [{ specFile: 'spec.md', tasks: [{ id: 'x', prompt: 'work', dependsOn: [12], source: 'x', agent: 'pi' }] }, 'invalid_dependencies'],
  ] as const) {
    await writeFile(f.batchFile, JSON.stringify(input));
    await assert.rejects(f.service.run(f.batchFile), (error: unknown) => {
      assert.ok(error instanceof TaskBatchValidationError);
      assert.equal(error.diagnostics[0].code, expectedCode);
      return true;
    });
  }
  await assert.rejects(readdir(f.storePath), { code: 'ENOENT' });
});

test('tasks CLI reports an invalid batch as machine-readable diagnostics without creating a run', async (t) => {
  const f = await fixture(t);
  await writeFile(f.batchFile, '{');
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = spawnSync(process.execPath, [cli, 'tasks', 'run', f.batchFile, '--cwd', f.repo, '--store', f.storePath, '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  const error = JSON.parse(run.stdout);
  assert.equal(error.status, 'invalid');
  assert.equal(error.diagnostics[0].code, 'invalid_json');
  await assert.rejects(readdir(f.storePath), { code: 'ENOENT' });
});
