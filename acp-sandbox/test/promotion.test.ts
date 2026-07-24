import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GitPromotion,
  PROMOTION_POLICIES,
  type AgentCheckpoint,
  type AgentCheckpointPreview,
  type PromotionDecision,
  type PromotionPolicy,
  type SubprocessExecutor,
  type SubprocessRequest,
  type SubprocessResult,
} from '../src/index.js';

const checkpoint: AgentCheckpoint = {
  runId: 'run-1',
  nodeId: 'implement',
  attempt: 1,
  sandboxName: 'sandbox-1',
  baseCommit: 'base123',
  commit: 'checkpoint456',
  remote: 'sandbox-sandbox-1',
  ref: 'refs/slopify/checkpoints/sandbox-1',
};

const preview: AgentCheckpointPreview = {
  baseCommit: checkpoint.baseCommit,
  checkpointCommit: checkpoint.commit,
  fileCount: 2,
  files: ['src/feature.ts', 'README.md'],
  diff: 'diff --git a/src/feature.ts b/src/feature.ts\n',
};

function result(stdout = '', stderr = '', exitCode = 0): SubprocessResult {
  return { stdout, stderr, exitCode };
}

function fakeGit(options: { head?: string; dirty?: boolean } = {}): {
  execute: SubprocessExecutor;
  calls: SubprocessRequest[];
} {
  const calls: SubprocessRequest[] = [];
  return {
    calls,
    execute: async request => {
      calls.push(request);
      if (request.args[0] === 'status') return result(options.dirty ? ' M local.ts\n' : '');
      if (request.args.join(' ') === 'rev-parse HEAD') return result(`${options.head ?? checkpoint.baseCommit}\n`);
      return result();
    },
  };
}

function mutatingCalls(calls: SubprocessRequest[]): SubprocessRequest[] {
  const mutating = new Set(['merge', 'checkout', 'switch', 'reset', 'cherry-pick', 'rebase', 'apply', 'am']);
  return calls.filter(call => call.command === 'git' && mutating.has(call.args[0] ?? ''));
}

async function promote(
  policy: PromotionPolicy,
  decision?: PromotionDecision,
  options: { head?: string; dirty?: boolean } = {},
) {
  const fake = fakeGit(options);
  let prompts = 0;
  const output = await new GitPromotion(fake.execute).promotePipelineChangeSet({
    workspaceCwd: '/repo',
    policy,
    checkpoint,
    preview,
    decide: decision
      ? request => {
          prompts += 1;
          assert.strictEqual(request.checkpoint, checkpoint);
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

test('ask presents one complete preview and explicit approval applies one atomic fast-forward', async () => {
  const { output, calls, prompts } = await promote('ask', 'apply');

  assert.equal(output.status, 'applied');
  assert.equal(prompts, 1);
  assert.deepEqual(mutatingCalls(calls).map(call => call.args), [
    ['merge', '--ff-only', '--no-edit', checkpoint.ref],
  ]);
});

test('auto-apply promotes without prompting', async () => {
  const { output, calls, prompts } = await promote('auto-apply');
  assert.equal(output.status, 'applied');
  assert.equal(prompts, 0);
  assert.equal(mutatingCalls(calls).length, 1);
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
      assert.deepEqual(mutatingCalls(calls), []);
    });
  }
});

test('no_changes skips the Promotion decision entirely', async () => {
  const fake = fakeGit();
  let prompts = 0;
  const output = await new GitPromotion(fake.execute).promotePipelineChangeSet({
    workspaceCwd: '/repo',
    policy: 'ask',
    checkpoint,
    preview: { ...preview, fileCount: 0, files: [], diff: '' },
    decide: () => {
      prompts += 1;
      return 'apply';
    },
  });

  assert.equal(output.status, 'no_changes');
  assert.equal(prompts, 0);
  assert.deepEqual(fake.calls, []);
});

test('a divergent Git base blocks Promotion before any mutation', async () => {
  const fake = fakeGit({ head: 'different789' });
  await assert.rejects(
    new GitPromotion(fake.execute).promotePipelineChangeSet({
      workspaceCwd: '/repo', policy: 'auto-apply', checkpoint, preview,
    }),
    /host Git base diverged from base123 to different789.*No changes were applied/,
  );
  assert.deepEqual(mutatingCalls(fake.calls), []);
});

test('late workspace changes block Promotion before any mutation', async () => {
  const fake = fakeGit({ dirty: true });
  await assert.rejects(
    new GitPromotion(fake.execute).promotePipelineChangeSet({
      workspaceCwd: '/repo', policy: 'auto-apply', checkpoint, preview,
    }),
    /host workspace changed after the sandbox run.*No changes were applied/,
  );
  assert.deepEqual(mutatingCalls(fake.calls), []);
});

test('an unsupported runtime policy fails closed', async () => {
  const fake = fakeGit();
  await assert.rejects(
    new GitPromotion(fake.execute).promotePipelineChangeSet({
      workspaceCwd: '/repo', policy: 'unexpected' as PromotionPolicy, checkpoint, preview,
    }),
    /Unsupported Promotion policy: unexpected/,
  );
  assert.deepEqual(mutatingCalls(fake.calls), []);
});
