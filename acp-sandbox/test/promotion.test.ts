import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GitPromotion,
  PROMOTION_POLICIES,
  type AgentCheckpointResult,
  type PipelineChangeSet,
  type PipelineChangeSetPreview,
  type PromotionDecision,
  type PromotionPolicy,
  type SubprocessExecutor,
  type SubprocessRequest,
  type SubprocessResult,
} from '../src/index.js';

function checkpoint(nodeId: string, attempt = 1, changed = true): AgentCheckpointResult {
  return {
    checkpointStatus: changed ? 'checkpointed' : 'no_changes',
    checkpoint: {
      runId: 'run-1',
      nodeId,
      attempt,
      sandboxName: `sandbox-${nodeId}-${attempt}`,
      baseCommit: 'base123',
      commit: `checkpoint-${nodeId}-${attempt}`,
      remote: `sandbox-${nodeId}-${attempt}`,
      ref: `refs/slopify/checkpoints/${nodeId}-${attempt}`,
    },
    preview: {
      baseCommit: 'base123',
      checkpointCommit: `checkpoint-${nodeId}-${attempt}`,
      fileCount: changed ? 1 : 0,
      files: changed ? [`src/${nodeId}.ts`] : [],
      diff: changed ? `diff --git a/src/${nodeId}.ts b/src/${nodeId}.ts\n` : '',
    },
  };
}

function result(stdout = '', stderr = '', exitCode = 0): SubprocessResult {
  return { stdout, stderr, exitCode };
}

function integrationGit(options: { head?: string; dirty?: boolean } = {}): {
  execute: SubprocessExecutor;
  calls: SubprocessRequest[];
} {
  const calls: SubprocessRequest[] = [];
  let commitIndex = 0;
  return {
    calls,
    execute: async request => {
      calls.push(request);
      const args = request.args;
      if (args.join(' ') === 'show -s --format=%cI base123') return result('2026-07-24T10:00:00+02:00\n');
      if (args[0] === 'merge-tree') return result(`tree-${args.at(-1)?.split('/').at(-1)}\n`);
      if (args[0] === 'commit-tree') return result(`integrated-${++commitIndex}\n`);
      if (args[0] === 'diff' && args.includes('--name-only')) return result('src/a.ts\nsrc/b.ts\n');
      if (args[0] === 'diff') return result('global diff\n');
      if (args[0] === 'status') return result(options.dirty ? ' M local.ts\n' : '');
      if (args.join(' ') === 'rev-parse HEAD') return result(`${options.head ?? 'base123'}\n`);
      return result();
    },
  };
}

function mutatingWorkspaceCalls(calls: SubprocessRequest[]): SubprocessRequest[] {
  const mutating = new Set(['merge', 'checkout', 'switch', 'reset', 'cherry-pick', 'rebase', 'apply', 'am']);
  return calls.filter(call => call.command === 'git' && mutating.has(call.args[0] ?? ''));
}

async function integratedChangeSet(fake = integrationGit()) {
  const output = await new GitPromotion(fake.execute).integrateAgentCheckpoints({
    workspaceCwd: '/repo',
    runId: 'run-1',
    checkpoints: [checkpoint('a'), checkpoint('b')],
  });
  return { ...output, fake };
}

async function promote(
  policy: PromotionPolicy,
  decision?: PromotionDecision,
  options: { head?: string; dirty?: boolean } = {},
) {
  const fake = integrationGit(options);
  const changeSet: PipelineChangeSet = {
    runId: 'run-1',
    baseCommit: 'base123',
    commit: 'integrated-2',
    ref: 'refs/slopify/runs/run-1/change-set',
    integratedNodeIds: ['a', 'b'],
  };
  const preview: PipelineChangeSetPreview = {
    baseCommit: 'base123',
    changeSetCommit: 'integrated-2',
    fileCount: 2,
    files: ['src/a.ts', 'src/b.ts'],
    diff: 'global diff\n',
  };
  let prompts = 0;
  const output = await new GitPromotion(fake.execute).promotePipelineChangeSet({
    workspaceCwd: '/repo',
    policy,
    changeSet,
    preview,
    decide: decision
      ? request => {
          prompts += 1;
          assert.strictEqual(request.changeSet, changeSet);
          assert.strictEqual(request.preview, preview);
          return decision;
        }
      : undefined,
  });
  return { output, calls: fake.calls, prompts };
}

test('exposes the four pipeline Promotion policies', () => {
  assert.deepEqual(PROMOTION_POLICIES, ['discard', 'ask', 'auto-apply', 'auto-reject']);
});

test('integrates Agent Checkpoints in the supplied deterministic order without mutating the host workspace', async () => {
  const { changeSet, preview, fake } = await integratedChangeSet();

  assert.deepEqual(changeSet.integratedNodeIds, ['a', 'b']);
  assert.equal(changeSet.commit, 'integrated-2');
  assert.equal(preview.fileCount, 2);
  assert.deepEqual(
    fake.calls.filter(call => call.args[0] === 'merge-tree').map(call => call.args.at(-1)),
    ['refs/slopify/checkpoints/a-1', 'refs/slopify/checkpoints/b-1'],
  );
  assert.deepEqual(mutatingWorkspaceCalls(fake.calls), []);
  assert.equal(fake.calls.filter(call => call.args[0] === 'update-ref').length, 1);
  const commitCalls = fake.calls.filter(call => call.args[0] === 'commit-tree');
  assert.equal(commitCalls.length, 2);
  assert.equal(commitCalls.every(call => call.env?.GIT_AUTHOR_DATE === '2026-07-24T10:00:00+02:00'), true);
});

test('reports an Integration Conflict without publishing or mutating the host workspace', async () => {
  const fake = integrationGit();
  let mergeIndex = 0;
  const execute: SubprocessExecutor = async request => {
    if (request.command === 'git' && request.args[0] === 'merge-tree' && ++mergeIndex === 2) {
      fake.calls.push(request);
      return result(
        '100644 abc 1\tsrc/shared.ts\n'
        + '100644 def 2\tsrc/shared.ts\n'
        + '100644 ghi 3\tsrc/shared.ts\n'
        + 'CONFLICT (content): Merge conflict in src/shared.ts\n',
        '',
        1,
      );
    }
    return fake.execute(request);
  };

  await assert.rejects(
    new GitPromotion(execute).integrateAgentCheckpoints({
      workspaceCwd: '/repo',
      runId: 'run-1',
      checkpoints: [checkpoint('a'), checkpoint('b')],
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'integration_conflict');
      assert.deepEqual(
        (error as { conflict: { checkpoints: AgentCheckpointResult['checkpoint'][] } })
          .conflict.checkpoints.map(item => `${item.nodeId}#${item.attempt}`),
        ['a#1', 'b#1'],
      );
      assert.deepEqual((error as { conflict: { files: string[] } }).conflict.files, ['src/shared.ts']);
      return true;
    },
  );

  assert.deepEqual(mutatingWorkspaceCalls(fake.calls), []);
  assert.equal(
    fake.calls.some(call => call.args[0] === 'update-ref' && call.args[1]?.includes('refs/slopify/runs/')),
    false,
  );
});

test('an empty checkpoint remains attributed but does not create an integration commit', async () => {
  const fake = integrationGit();
  const output = await new GitPromotion(fake.execute).integrateAgentCheckpoints({
    workspaceCwd: '/repo',
    runId: 'run-1',
    checkpoints: [checkpoint('a', 1, false)],
  });

  assert.deepEqual(output.changeSet.integratedNodeIds, ['a']);
  assert.equal(output.changeSet.commit, 'base123');
  assert.equal(output.preview.fileCount, 0);
  assert.equal(fake.calls.some(call => call.args[0] === 'merge-tree'), false);
  assert.deepEqual(mutatingWorkspaceCalls(fake.calls), []);
});

test('ask presents one global preview and explicit approval applies one atomic fast-forward', async () => {
  const { output, calls, prompts } = await promote('ask', 'apply');

  assert.equal(output.status, 'applied');
  assert.equal(prompts, 1);
  assert.deepEqual(mutatingWorkspaceCalls(calls).map(call => call.args), [
    ['merge', '--ff-only', '--no-edit', 'refs/slopify/runs/run-1/change-set'],
  ]);
});

test('auto-apply promotes the complete change set without prompting', async () => {
  const { output, calls, prompts } = await promote('auto-apply');
  assert.equal(output.status, 'applied');
  assert.equal(prompts, 0);
  assert.equal(mutatingWorkspaceCalls(calls).length, 1);
});

test('discard, auto-reject, user rejection and cancellation never mutate the host workspace', async t => {
  const cases: Array<[string, PromotionPolicy, PromotionDecision | undefined, 'rejected' | 'cancelled']> = [
    ['discard', 'discard', undefined, 'rejected'],
    ['auto-reject', 'auto-reject', undefined, 'rejected'],
    ['user rejection', 'ask', 'reject', 'rejected'],
    ['cancellation', 'ask', 'cancel', 'cancelled'],
  ];

  for (const [name, policy, decision, expected] of cases) {
    await t.test(name, async () => {
      const { output, calls } = await promote(policy, decision);
      assert.equal(output.status, expected);
      assert.deepEqual(mutatingWorkspaceCalls(calls), []);
    });
  }
});

test('no_changes skips the global Promotion decision entirely', async () => {
  const fake = integrationGit();
  let prompts = 0;
  const output = await new GitPromotion(fake.execute).promotePipelineChangeSet({
    workspaceCwd: '/repo',
    policy: 'ask',
    changeSet: {
      runId: 'run-1', baseCommit: 'base123', commit: 'base123', ref: 'base123', integratedNodeIds: ['a'],
    },
    preview: { baseCommit: 'base123', changeSetCommit: 'base123', fileCount: 0, files: [], diff: '' },
    decide: () => {
      prompts += 1;
      return 'apply';
    },
  });

  assert.equal(output.status, 'no_changes');
  assert.equal(prompts, 0);
  assert.deepEqual(fake.calls, []);
});

test('a divergent Git base blocks Promotion before any workspace mutation', async () => {
  const fake = integrationGit({ head: 'different789' });
  await assert.rejects(
    new GitPromotion(fake.execute).promotePipelineChangeSet({
      workspaceCwd: '/repo',
      policy: 'auto-apply',
      changeSet: {
        runId: 'run-1', baseCommit: 'base123', commit: 'integrated-2', ref: 'refs/slopify/runs/run-1/change-set', integratedNodeIds: ['a', 'b'],
      },
      preview: { baseCommit: 'base123', changeSetCommit: 'integrated-2', fileCount: 2, files: ['a', 'b'], diff: 'x' },
    }),
    /host Git base diverged from base123 to different789.*No changes were applied/,
  );
  assert.deepEqual(mutatingWorkspaceCalls(fake.calls), []);
});

test('late workspace changes block Promotion before any workspace mutation', async () => {
  const fake = integrationGit({ dirty: true });
  await assert.rejects(
    new GitPromotion(fake.execute).promotePipelineChangeSet({
      workspaceCwd: '/repo',
      policy: 'auto-apply',
      changeSet: {
        runId: 'run-1', baseCommit: 'base123', commit: 'integrated-2', ref: 'refs/slopify/runs/run-1/change-set', integratedNodeIds: ['a', 'b'],
      },
      preview: { baseCommit: 'base123', changeSetCommit: 'integrated-2', fileCount: 2, files: ['a', 'b'], diff: 'x' },
    }),
    /host workspace changed after the sandbox runs.*No changes were applied/,
  );
  assert.deepEqual(mutatingWorkspaceCalls(fake.calls), []);
});
