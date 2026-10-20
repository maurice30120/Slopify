import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { TaskBatchValidationError } from '@slopify/task-batches';
import type { LocalAgentRunner } from '@slopify/execution-local';
import { TaskBatchService } from './taskBatchTestService.js';

async function fixture(t: { after(fn: () => Promise<void>): void }, localAgentRunner?: LocalAgentRunner) {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-review-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(repo, 'README.md'), '# Plain text project\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  await writeFile(path.join(root, 'spec.md'), '# Approved specification\n');
  const batchFile = path.join(root, 'batch.json');
  const batch = {
    specFile: 'spec.md',
    tasks: [{ id: 'work', agent: 'codex', prompt: 'Implement the text requirement.', source: 'work.md', dependsOn: [] }],
  };
  const service = new TaskBatchService({ repositoryPath: repo, storePath: path.join(root, 'runs'), localAgentRunner });
  return { root, repo, batchFile, batch, service };
}

test('the final review freezes explicit batch validation commands instead of assuming npm', async t => {
  const f = await fixture(t);
  const command = 'python3 -m unittest discover';
  await writeFile(f.batchFile, JSON.stringify({ ...f.batch, validationCommands: [command] }));

  const run = await f.service.run(f.batchFile, { execute: false });

  const review = run.tasks.find(task => task.source === 'final-review')!;
  assert.ok(review.prompt.includes(command), 'the reviewer receives the specified project check');
  assert.doesNotMatch(review.prompt, /npm run build|npm test/);
  const frozen = JSON.parse(await readFile(run.context.batchFile, 'utf8'));
  assert.deepEqual(frozen.validationCommands, [command]);
});

test('a batch without explicit commands delegates validation from its pinned repository documentation', async t => {
  const f = await fixture(t);
  await writeFile(f.batchFile, JSON.stringify(f.batch));

  const run = await f.service.run(f.batchFile, { execute: false });

  const review = run.tasks.find(task => task.source === 'final-review')!;
  assert.doesNotMatch(review.prompt, /npm run build|npm test|monorepo complet/);
  assert.ok(review.prompt.includes(`commandes de validation documentées dans le dépôt au commit ${run.runBaseCommit}`));
  assert.match(review.prompt, /critères d'acceptation/);
});

for (const invalid of [[], '', [''], [' \t '], ['echo first\necho second'], ['echo first\r\necho second'], ['echo\0bad'], [42]]) {
  test(`invalid validation commands are refused before a run is created: ${JSON.stringify(invalid)}`, async t => {
    const f = await fixture(t);
    await writeFile(f.batchFile, JSON.stringify({ ...f.batch, validationCommands: invalid }));

    await assert.rejects(f.service.run(f.batchFile, { execute: false }), (error: unknown) => {
      assert.ok(error instanceof TaskBatchValidationError);
      assert.ok(error.diagnostics.some(diagnostic => diagnostic.path?.startsWith('validationCommands')));
      return true;
    });
    await assert.rejects(readdir(path.join(f.root, 'runs')), { code: 'ENOENT' });
  });
}

test('an applicable validation failure blocks the run and resume keeps the original review checks', async t => {
  const prompts: string[] = [];
  let validationsPass = false;
  let implementationRuns = 0;
  const f = await fixture(t, async request => {
    if (request.taskId === 'work') {
      implementationRuns++;
      await writeFile(path.join(request.workspacePath, 'implemented.txt'), 'implemented\n');
      return { exitCode: 0, report: 'Implementation complete.', diagnostics: [] };
    }
    prompts.push(request.prompt);
    return validationsPass
      ? { exitCode: 0, report: 'Project checks passed.', diagnostics: [] }
      : { exitCode: 1, report: 'python3 -m unittest discover failed with exit 1.', diagnostics: [{ code: 'validation_failed', message: 'The required project check failed.' }] };
  });
  await writeFile(f.batchFile, JSON.stringify({ ...f.batch, validationCommands: ['python3 -m unittest discover'] }));

  const first = await f.service.run(f.batchFile, { mode: 'local' });

  assert.equal(first.status, 'failed');
  assert.equal(first.tasks.find(task => task.source === 'final-review')!.status, 'failed');
  assert.ok(prompts[0].includes('python3 -m unittest discover'));
  await writeFile(f.batchFile, JSON.stringify({ ...f.batch, validationCommands: ['echo new configuration'] }));
  await writeFile(path.join(f.repo, 'README.md'), '# Changed host documentation\n');
  validationsPass = true;

  const resumed = await f.service.resume(first.runId);

  assert.equal(resumed.status, 'succeeded');
  assert.equal(implementationRuns, 1, 'the implementation checkpoint is reused');
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1], prompts[0], 'the persisted review prompt and commands survive configuration changes');
  assert.doesNotMatch(prompts[1], /echo new configuration/);
  assert.equal(await readFile(path.join(f.repo, 'README.md'), 'utf8'), '# Changed host documentation\n');
});
