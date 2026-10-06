import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorkspaceRun } from '@acp-client/workspace';
import type { PipelineRuntimeResult } from '@acp-client/pipeline';

test('delivery approval inspects checkpoint documents without promoting them to the host', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-handoff-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@localhost');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(cwd, 'README.md'), 'Base\n');
  git('add', '.'); git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const feature = path.join(cwd, '.scratch', 'feature');
  fs.mkdirSync(path.join(feature, 'issues'), { recursive: true });
  fs.writeFileSync(path.join(feature, 'spec.md'), '# Specification from sandbox\n');
  fs.writeFileSync(path.join(feature, 'issues', '01-fix.md'), '# Ticket\n\n**Ticket ID:** T01\n');
  git('add', '.'); git('commit', '-m', 'sandbox documents');
  const commit = git('rev-parse', 'HEAD');
  const ref = 'refs/slopify/checkpoints/tasks';
  git('update-ref', ref, commit); git('reset', '--hard', base);
  const result: PipelineRuntimeResult = {
    status: 'paused', runId: 'handoff',
    pause: { id: 'approve', nodeId: 'delivery_approval', type: 'approval', format: 'proposed-plan',
      content: '`.scratch/feature/spec.md`\n`.scratch/feature/issues/`', workspaceGuard: 'documentation-only',
      handoff: { kind: 'workspace-files', minimumReferences: 2, layout: 'delivery' } },
    snapshot: { runId: 'handoff', pipelineId: 'full', status: 'paused', artifacts: {}, diagnostics: [],
      nodeStates: {}, createdAt: '', updatedAt: '', sandboxRuns: { tasks: {
        sandboxName: 'tasks', runId: 'handoff', nodeId: 'tasks', attempt: 1, baseCommit: base,
        integrationState: 'checkpointed', resourceState: 'removed', checkpoint: {
          status: 'checkpointed', commit, remote: 'tasks', ref,
          preview: { baseCommit: base, checkpointCommit: commit, fileCount: 2,
            files: ['.scratch/feature/spec.md', '.scratch/feature/issues/01-fix.md'], diff: '' },
        },
      } } },
  };
  const run = createWorkspaceRun({ workspaceCwd: cwd, start: async () => result, resume: async () => result });
  const outcome = await run.start('full', 'Fix');
  assert.equal(outcome.status, 'interaction-required');
  assert.ok(outcome.status === 'interaction-required');
  assert.match(outcome.interaction.content, /Specification from sandbox/);
  assert.equal(fs.existsSync(feature), false);
  assert.equal(git('rev-parse', 'HEAD'), base);
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gm)?.length, 1);
});
