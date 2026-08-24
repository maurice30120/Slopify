import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PipelineRuntime,
  compilePipelineV3Definition,
  type PipelineNodeExecutionResult,
  type PipelineRuntimeAdapter,
  type PipelineRuntimeSnapshot,
  type PipelineSandboxRunSnapshot,
} from '@acp-client/pipeline';
import type { SubprocessRequest, SubprocessResult } from '@acp-client/sandbox';
import { createWorkspaceRuntime } from '../src/index.js';

function result(stdout = '', stderr = '', exitCode = 0): SubprocessResult {
  return { stdout, stderr, exitCode };
}

test('collects parallel sandbox checkpoints, previews once, and promotes one deterministic change set', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-workspace-multi-agent-'));
  fs.mkdirSync(path.join(cwd, '.acp'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.acp', 'acp-agents.json'), JSON.stringify({ agents: {
    Isolated: { transport: 'sandbox', agent: 'codex', model: 'gpt-5.6-codex' },
  } }));

  const calls: SubprocessRequest[] = [];
  let integrationCommit = 0;
  let promotionPrompts = 0;
  const runtime = createWorkspaceRuntime({
    workspaceCwd: cwd,
    host: {
      permissionContext: () => undefined,
      requestPipelinePromotion: async request => {
        promotionPrompts += 1;
        assert.deepEqual(request.integratedNodeIds, ['a', 'b']);
        assert.deepEqual(request.preview.files, ['src/a.ts', 'src/b.ts']);
        return 'approve';
      },
      logger: { log: () => undefined, error: () => undefined },
    },
    sandboxExecutor: async request => {
      calls.push(request);
      const args = request.args;
      const joined = args.join(' ');
      if (request.command === 'git' && joined === 'rev-parse --is-inside-work-tree') return result('true\n');
      if (request.command === 'git' && joined === 'status --porcelain=v1') return result();
      if (request.command === 'git' && joined === 'rev-parse HEAD') return result('base123\n');
      if (request.command === 'git' && args[0] === 'rev-parse' && args[1]?.startsWith('refs/slopify/checkpoints/')) {
        return result(`checkpoint-${args[1].includes('-a-') ? 'a' : 'b'}\n`);
      }
      if (request.command === 'git' && joined === 'show -s --format=%cI base123') return result('2026-07-24T10:00:00+02:00\n');
      if (request.command === 'git' && args[0] === 'merge-tree') return result(`tree-${args.at(-1)?.includes('-a-') ? 'a' : 'b'}\n`);
      if (request.command === 'git' && args[0] === 'commit-tree') return result(`integrated-${++integrationCommit}\n`);
      if (request.command === 'git' && args[0] === 'diff' && args.includes('--name-only')) {
        const range = args.at(-1) ?? '';
        if (range.includes('refs/slopify/runs/')) return result('src/a.ts\nsrc/b.ts\n');
        return result(range.includes('-a-') ? 'src/a.ts\n' : 'src/b.ts\n');
      }
      if (request.command === 'git' && args[0] === 'diff') {
        const range = args.at(-1) ?? '';
        return result(range.includes('refs/slopify/runs/') ? 'global diff\n' : 'checkpoint diff\n');
      }
      if (joined === 'version') return result('Docker Sandbox 0.35.0\n');
      if (joined === 'create --help') return result('Usage: sbx create --clone');
      if (joined === 'ls --help') return result('Usage: sbx ls --json');
      if (joined === 'ls --json') return result('[]');
      if (joined === 'policy init --help') return result('Usage: sbx policy init');
      return result();
    },
  });

  const program = compilePipelineV3Definition({
    version: 3,
    id: 'multi-agent',
    title: 'Multi-agent',
    promotion: 'ask',
    nodes: [
      {
        id: 'a', agent: 'Isolated', prompt: 'A',
        policy: { filesystem: 'workspace-write', terminal: 'workspace-write', promotion: 'ask' },
        output: { name: 'out', type: 'note', format: 'text' },
      },
      {
        id: 'b', agent: 'Isolated', prompt: 'B',
        policy: { filesystem: 'workspace-write', terminal: 'workspace-write', promotion: 'ask' },
        output: { name: 'out', type: 'note', format: 'text' },
      },
      {
        id: 'final-review', agent: 'Isolated', prompt: 'Review', needs: ['a', 'b'],
        output: { name: 'review', type: 'acp.verification-report/v1', format: 'json' },
      },
    ],
  }, { Isolated: {} }).program!;

  await Promise.all([
    runtime.runAgent({
      workspaceCwd: cwd, agentName: 'Isolated', runId: 'run-e2e-accept', nodeId: 'b', attempt: 1,
      promptText: 'B', sideEffects: 'workspace', promotion: 'ask',
    }),
    runtime.runAgent({
      workspaceCwd: cwd, agentName: 'Isolated', runId: 'run-e2e-accept', nodeId: 'a', attempt: 1,
      promptText: 'A', sideEffects: 'workspace', promotion: 'ask',
    }),
  ]);

  const coordinatedAdapter = (verdict: 'passed' | 'failed', reviewedPrompts: string[]): PipelineRuntimeAdapter => ({
    preparePipelineChangeSet: input => runtime.runAgent.preparePipelineChangeSet!(input),
    finalizePipelineChangeSet: input => runtime.runAgent.finalizePipelineChangeSet!(input),
    invalidatePipelineChangeSet: input => runtime.runAgent.invalidatePipelineChangeSet!(input),
    async createSession({ runId, node }) {
      return { runId, nodeId: node.id, async send(input): Promise<PipelineNodeExecutionResult> {
        if (node.id === 'final-review') {
          reviewedPrompts.push(input.prompt);
          return { artifact: { name: 'review', type: 'acp.verification-report/v1', format: 'json', value: {
            contract: 'acp.verification-report/v1', verdict, categories: [{
              name: 'complete-change-set', required: true, status: verdict, details: verdict,
            }],
          } } };
        }
        return { artifact: { name: 'out', type: 'note', format: 'text', value: node.id } };
      }, async cancel() {}, async close() {} };
    },
  });
  const reviewedPrompts: string[] = [];
  const accepted = await new PipelineRuntime(coordinatedAdapter('passed', reviewedPrompts), {
    runIdFactory: () => 'run-e2e-accept',
  }).start(program, { maxConcurrency: 2 });

  assert.equal(accepted.status, 'completed');
  const acceptedChangeSet = (accepted as typeof accepted & { changeSet?: { integratedNodeIds: string[]; changeSetRef?: string } }).changeSet;
  assert.deepEqual(acceptedChangeSet?.integratedNodeIds, ['a', 'b']);
  assert.match(reviewedPrompts[0], /global diff/);
  assert.match(reviewedPrompts[0], /src\/a\.ts/);
  assert.match(reviewedPrompts[0], /src\/b\.ts/);
  assert.equal(promotionPrompts, 1);
  assert.deepEqual(
    calls.filter(call => call.command === 'git' && call.args[0] === 'merge-tree').map(call => call.args.at(-1)?.includes('-a-') ? 'a' : 'b'),
    ['a', 'b'],
  );
  assert.deepEqual(
    calls.filter(call => call.command === 'git' && call.args[0] === 'merge').map(call => call.args),
    [['merge', '--ff-only', '--no-edit', acceptedChangeSet?.changeSetRef]],
  );

  await Promise.all(['a', 'b'].map(nodeId => runtime.runAgent({
    workspaceCwd: cwd, agentName: 'Isolated', runId: 'run-e2e-reject', nodeId, attempt: 1,
    promptText: nodeId, sideEffects: 'workspace', promotion: 'ask',
  })));
  const rejectCallsStart = calls.length;
  const rejected = await new PipelineRuntime(coordinatedAdapter('failed', []), {
    runIdFactory: () => 'run-e2e-reject',
  }).start(program, { maxConcurrency: 2 });
  const rejectCalls = calls.slice(rejectCallsStart);

  assert.equal(rejected.status, 'cancelled');
  assert.equal(promotionPrompts, 1, 'rejected review never asks to promote');
  assert.equal(rejectCalls.some(call => call.command === 'git' && call.args[0] === 'merge'), false);
  const publishedRejectRef = rejectCalls.find(call => call.command === 'git' && call.args[0] === 'update-ref' && call.args[1] !== '-d')?.args[1];
  assert.ok(publishedRejectRef);
  assert.equal(rejectCalls.some(call => call.command === 'git' && call.args.join(' ') === `update-ref -d ${publishedRejectRef}`), true);
});

test('integrates the highest checkpoint attempt and cleans up superseded attempt refs', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-workspace-retry-'));
  const calls: SubprocessRequest[] = [];
  const runtime = createWorkspaceRuntime({
    workspaceCwd: cwd,
    resolvedCatalog: {
      agents: { Isolated: { transport: 'sandbox', agent: 'codex', model: 'gpt-5.6-codex' } },
      config: {
        filePath: path.join(cwd, '.acp', 'acp-agents.json'),
        agents: {},
        pipeline: { enabled: true, instructionsMaxBytes: 256 * 1024, timeouts: {} },
        errors: [],
      },
      errors: [],
    },
    host: {
      permissionContext: () => undefined,
      logger: { log: () => undefined, error: () => undefined },
    },
    sandboxExecutor: async request => {
      calls.push(request);
      const args = request.args;
      const joined = args.join(' ');
      if (request.command === 'git' && joined === 'rev-parse --is-inside-work-tree') return result('true\n');
      if (request.command === 'git' && joined === 'status --porcelain=v1') return result();
      if (request.command === 'git' && joined === 'rev-parse HEAD') return result('base123\n');
      if (request.command === 'git' && args[0] === 'rev-parse' && args[1]?.startsWith('refs/slopify/checkpoints/')) {
        return result(`checkpoint-${args[1].match(/-(\d+)-[a-f0-9]+$/)?.[1]}\n`);
      }
      if (request.command === 'git' && joined === 'show -s --format=%cI base123') return result('2026-07-24T10:00:00+02:00\n');
      if (request.command === 'git' && args[0] === 'merge-tree') return result('tree\n');
      if (request.command === 'git' && args[0] === 'commit-tree') return result('integrated\n');
      if (request.command === 'git' && args[0] === 'diff' && args.includes('--name-only')) return result('src/a.ts\n');
      if (request.command === 'git' && args[0] === 'diff') return result('diff\n');
      if (joined === 'version') return result('Docker Sandbox 0.35.0\n');
      if (joined === 'create --help') return result('Usage: sbx create --clone');
      if (joined === 'ls --help') return result('Usage: sbx ls --json');
      if (joined === 'ls --json') return result('[]');
      if (joined === 'policy init --help') return result('Usage: sbx policy init');
      return result();
    },
  });
  const program = compilePipelineV3Definition({
    version: 3,
    id: 'retry',
    title: 'Retry',
    nodes: [{
      id: 'a', agent: 'Isolated', prompt: 'A',
      policy: { filesystem: 'workspace-write', terminal: 'workspace-write', promotion: 'discard' },
      output: { name: 'out', type: 'note', format: 'text' },
    }],
  }, { Isolated: {} }).program!;

  for (const attempt of [2, 1]) {
    await runtime.runAgent({
      workspaceCwd: cwd, agentName: 'Isolated', runId: 'run-retry', nodeId: 'a', attempt,
      promptText: 'A', sideEffects: 'workspace', promotion: 'discard',
    });
  }
  await runtime.runAgent.finalizePipelineChangeSet!({ runId: 'run-retry', program });

  const integratedRef = calls.find(call => call.command === 'git' && call.args[0] === 'merge-tree')?.args.at(-1);
  assert.match(integratedRef ?? '', /-2-[a-f0-9]+$/);
  assert.deepEqual(
    calls.filter(call => call.command === 'git' && call.args[0] === 'update-ref' && call.args[1] === '-d')
      .map(call => call.args[2]?.match(/-(\d+)-[a-f0-9]+$/)?.[1]),
    ['1'],
  );
});

test('preserves valid checkpoints across an Integration Conflict and replaces only the retried node attempt', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-workspace-conflict-retry-'));
  fs.mkdirSync(path.join(cwd, '.acp'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.acp', 'acp-agents.json'), JSON.stringify({ agents: {
    Isolated: { transport: 'sandbox', agent: 'codex', model: 'gpt-5.6-codex' },
  } }));
  const calls: SubprocessRequest[] = [];
  let integrationRound = 0;
  const runtime = createWorkspaceRuntime({
    workspaceCwd: cwd,
    host: {
      permissionContext: () => undefined,
      logger: { log: () => undefined, error: () => undefined },
    },
    sandboxExecutor: async request => {
      calls.push(request);
      const args = request.args;
      const joined = args.join(' ');
      if (request.command === 'git' && joined === 'rev-parse --is-inside-work-tree') return result('true\n');
      if (request.command === 'git' && joined === 'status --porcelain=v1') return result();
      if (request.command === 'git' && joined === 'rev-parse HEAD') return result('base123\n');
      if (request.command === 'git' && args[0] === 'rev-parse' && args[1]?.startsWith('refs/slopify/checkpoints/')) {
        const ref = args[1];
        const node = ref.includes('-a-') ? 'a' : 'b';
        const attempt = ref.match(/-(\d+)-[a-f0-9]+$/)?.[1];
        return result(`checkpoint-${node}-${attempt}\n`);
      }
      if (request.command === 'git' && joined === 'show -s --format=%cI base123') {
        integrationRound += 1;
        return result('2026-07-24T10:00:00+02:00\n');
      }
      if (request.command === 'git' && args[0] === 'merge-tree') {
        const ref = args.at(-1) ?? '';
        if (integrationRound === 1 && ref.includes('-b-1-')) {
          return result(
            '100644 abc 1\tsrc/shared.ts\n'
            + '100644 def 2\tsrc/shared.ts\n'
            + '100644 ghi 3\tsrc/shared.ts\n'
            + 'CONFLICT (content): Merge conflict in src/shared.ts\n',
            '',
            1,
          );
        }
        return result(`tree-${ref.includes('-a-') ? 'a-1' : 'b-2'}\n`);
      }
      if (request.command === 'git' && args[0] === 'commit-tree') return result(`integrated-${integrationRound}-${args[1]}\n`);
      if (request.command === 'git' && args[0] === 'diff' && args.includes('--name-only')) return result('src/shared.ts\n');
      if (request.command === 'git' && args[0] === 'diff') return result('diff\n');
      if (joined === 'version') return result('Docker Sandbox 0.35.0\n');
      if (joined === 'create --help') return result('Usage: sbx create --clone');
      if (joined === 'ls --help') return result('Usage: sbx ls --json');
      if (joined === 'ls --json') return result('[]');
      if (joined === 'policy init --help') return result('Usage: sbx policy init');
      return result();
    },
  });
  const program = compilePipelineV3Definition({
    version: 3,
    id: 'conflict-retry',
    title: 'Conflict retry',
    nodes: [
      {
        id: 'a', agent: 'Isolated', prompt: 'A',
        policy: { filesystem: 'workspace-write', terminal: 'workspace-write', promotion: 'discard' },
        output: { name: 'out', type: 'note', format: 'text' },
      },
      {
        id: 'b', agent: 'Isolated', prompt: 'B',
        policy: { filesystem: 'workspace-write', terminal: 'workspace-write', promotion: 'discard' },
        output: { name: 'out', type: 'note', format: 'text' },
      },
    ],
  }, { Isolated: {} }).program!;
  const run = (nodeId: string, attempt: number) => runtime.runAgent({
    workspaceCwd: cwd,
    agentName: 'Isolated',
    runId: 'run-conflict-retry',
    nodeId,
    attempt,
    promptText: nodeId.toUpperCase(),
    sideEffects: 'workspace',
    promotion: 'discard',
  });

  await run('a', 1);
  await run('b', 1);
  await assert.rejects(
    runtime.runAgent.finalizePipelineChangeSet!({ runId: 'run-conflict-retry', program }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'integration_conflict');
      assert.equal((error as { conflict: { retryNodeId: string } }).conflict.retryNodeId, 'b');
      return true;
    },
  );
  assert.equal(calls.some(call => call.command === 'git' && call.args[0] === 'update-ref' && call.args[1] === '-d'), false);

  await run('b', 2);
  await runtime.runAgent.finalizePipelineChangeSet!({ runId: 'run-conflict-retry', program });

  const integratedRefs = calls
    .filter(call => call.command === 'git' && call.args[0] === 'merge-tree')
    .slice(-2)
    .map(call => call.args.at(-1));
  assert.match(integratedRefs[0] ?? '', /-a-1-[a-f0-9]+$/);
  assert.match(integratedRefs[1] ?? '', /-b-2-[a-f0-9]+$/);
  assert.deepEqual(
    calls.filter(call => call.command === 'git' && call.args[0] === 'update-ref' && call.args[1] === '-d')
      .map(call => call.args[2]),
    [calls.find(call => call.command === 'git' && call.args[0] === 'merge-tree' && call.args.at(-1)?.includes('-b-1-'))?.args.at(-1)],
  );
});

test('preserves volatile checkpoint state and durable refs for an immediate finalization retry', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-workspace-finalization-failure-'));
  fs.mkdirSync(path.join(cwd, '.acp'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.acp', 'acp-agents.json'), JSON.stringify({ agents: {
    Isolated: { transport: 'sandbox', agent: 'codex', model: 'gpt-5.6-codex' },
  } }));
  const calls: SubprocessRequest[] = [];
  const runtime = createWorkspaceRuntime({
    workspaceCwd: cwd,
    host: {
      permissionContext: () => undefined,
      logger: { log: () => undefined, error: () => undefined },
    },
    sandboxExecutor: async request => {
      calls.push(request);
      const joined = request.args.join(' ');
      if (request.command === 'git' && joined === 'rev-parse --is-inside-work-tree') return result('true\n');
      if (request.command === 'git' && joined === 'status --porcelain=v1') return result();
      if (request.command === 'git' && joined === 'rev-parse HEAD') return result('base123\n');
      if (request.command === 'git' && request.args[0] === 'rev-parse') return result('checkpoint456\n');
      if (request.command === 'git' && request.args[0] === 'diff' && request.args.includes('--name-only')) return result('work.ts\n');
      if (request.command === 'git' && request.args[0] === 'diff') return result('work diff\n');
      if (request.command === 'git' && joined === 'show -s --format=%cI base123') return result('', 'corrupt base commit', 1);
      if (joined === 'version') return result('Docker Sandbox 0.35.0\n');
      if (joined === 'create --help') return result('Usage: sbx create --clone');
      if (joined === 'ls --help') return result('Usage: sbx ls --json');
      if (joined === 'ls --json') return result('[]');
      if (joined === 'policy init --help') return result('Usage: sbx policy init');
      return result();
    },
  });
  const program = compilePipelineV3Definition({
    version: 3,
    id: 'finalization-failure',
    title: 'Finalization failure',
    nodes: [{
      id: 'work', agent: 'Isolated', prompt: 'Work',
      policy: { filesystem: 'workspace-write', terminal: 'workspace-write', promotion: 'discard' },
      output: { name: 'out', type: 'note', format: 'text' },
    }],
  }, { Isolated: {} }).program!;

  await runtime.runAgent({
    workspaceCwd: cwd, agentName: 'Isolated', runId: 'reused-run', nodeId: 'work', attempt: 1,
    promptText: 'Work', sideEffects: 'workspace', promotion: 'discard',
  });
  await assert.rejects(
    runtime.runAgent.finalizePipelineChangeSet!({ runId: 'reused-run', program }),
    /corrupt base commit/,
  );

  await assert.rejects(
    runtime.runAgent.finalizePipelineChangeSet!({ runId: 'reused-run', program }),
    /corrupt base commit/,
  );
  const deletedRefs = calls
    .filter(call => call.command === 'git' && call.args.slice(0, 2).join(' ') === 'update-ref -d')
    .map(call => call.args[2]);
  assert.deepEqual(deletedRefs, []);
});

test('finalizes from persisted sandbox checkpoints after the workspace runtime is reconstructed', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-workspace-durable-resume-'));
  const calls: SubprocessRequest[] = [];
  const execute = async (request: SubprocessRequest): Promise<SubprocessResult> => {
    calls.push(request);
    const joined = request.args.join(' ');
    if (request.command === 'git' && joined === 'rev-parse --is-inside-work-tree') return result('true\n');
    if (request.command === 'git' && joined === 'status --porcelain=v1') return result();
    if (request.command === 'git' && joined === 'rev-parse HEAD') return result('base123\n');
    if (request.command === 'git' && request.args[0] === 'rev-parse' && request.args[1]?.startsWith('refs/slopify/checkpoints/')) return result('checkpoint456\n');
    if (request.command === 'git' && joined === 'show -s --format=%cI base123') return result('2026-07-24T10:00:00+02:00\n');
    if (request.command === 'git' && request.args[0] === 'merge-tree') return result('tree-resumed\n');
    if (request.command === 'git' && request.args[0] === 'commit-tree') return result('integrated-resumed\n');
    if (request.command === 'git' && request.args[0] === 'diff' && request.args.includes('--name-only')) return result('src/resumed.ts\n');
    if (request.command === 'git' && request.args[0] === 'diff') return result('resumed diff\n');
    if (joined === 'version') return result('Docker Sandbox 0.35.0\n');
    if (joined === 'create --help') return result('Usage: sbx create --clone');
    if (joined === 'ls --help') return result('Usage: sbx ls --json');
    if (joined === 'ls --json') return result('[]');
    if (joined === 'policy init --help') return result('Usage: sbx policy init');
    if (joined === 'policy ls --json') return result('[{"name":"local-policy"}]');
    return result();
  };
  const catalog = {
    agents: { Isolated: { transport: 'sandbox' as const, agent: 'codex' as const, model: 'gpt-5.6-codex' } },
    config: { filePath: '', agents: {}, pipeline: { enabled: true, instructionsMaxBytes: 1, timeouts: {} }, errors: [] },
    errors: [],
  };
  const host = {
    permissionContext: () => undefined,
    logger: { log: () => undefined, error: () => undefined },
  };
  const program = compilePipelineV3Definition({
    version: 3,
    id: 'durable-resume',
    title: 'Durable resume',
    nodes: [{
      id: 'work', agent: 'Isolated', prompt: 'Work',
      policy: { filesystem: 'workspace-write', terminal: 'workspace-write', promotion: 'discard' },
      output: { name: 'out', type: 'note', format: 'text' },
    }],
  }, { Isolated: {} }).program!;
  const sandboxRuns: Record<string, PipelineSandboxRunSnapshot> = {};
  const first = createWorkspaceRuntime({ workspaceCwd: cwd, resolvedCatalog: catalog, host, sandboxExecutor: execute });
  await first.runAgent({
    workspaceCwd: cwd,
    agentName: 'Isolated',
    runId: 'run-durable',
    nodeId: 'work',
    attempt: 1,
    promptText: 'Work',
    sideEffects: 'workspace',
    promotion: 'discard',
    onSandboxRunState: state => { sandboxRuns[state.sandboxName] = structuredClone(state); },
  });
  calls.length = 0;
  const snapshot: PipelineRuntimeSnapshot = {
    runId: 'run-durable', pipelineId: program.id, status: 'completed',
    nodeStates: { work: { status: 'completed', attempts: 1 } },
    artifacts: {}, diagnostics: [], sandboxRuns,
    createdAt: '2026-07-24T10:00:00.000Z', updatedAt: '2026-07-24T10:00:01.000Z',
  };
  snapshot.pipelineChangeSet = await first.runAgent.preparePipelineChangeSet!({
    runId: 'run-durable',
    program,
    snapshot,
  });

  const reconstructed = createWorkspaceRuntime({ workspaceCwd: cwd, resolvedCatalog: catalog, host, sandboxExecutor: execute });
  calls.length = 0;
  const finalized = await reconstructed.runAgent.finalizePipelineChangeSet!({
    runId: 'run-durable',
    program,
    snapshot,
  });

  assert.equal(finalized.promotion, 'rejected');
  assert.deepEqual(finalized.integratedNodeIds, ['work']);
  assert.equal(calls.some(call => call.command === 'git' && call.args[0] === 'merge-tree'), false, 'the persisted provisional Change Set is not integrated twice');
  assert.equal(calls.some(call => call.args.join(' ') === 'ls --json'), false, 'a removed sandbox is not required once its checkpoint was fetched');
});

test('does not integrate a durable checkpoint produced by a read-only node', async () => {
  const calls: SubprocessRequest[] = [];
  const runtime = createWorkspaceRuntime({
    workspaceCwd: '/repo',
    resolvedCatalog: {
      agents: {},
      config: { filePath: '', agents: {}, pipeline: { enabled: true, instructionsMaxBytes: 1, timeouts: {} }, errors: [] },
      errors: [],
    },
    host: {
      permissionContext: () => undefined,
      logger: { log: () => undefined, error: () => undefined },
    },
    sandboxExecutor: async request => { calls.push(request); return result(); },
  });
  const program = compilePipelineV3Definition({
    version: 3, id: 'read-only-checkpoint', title: 'Read only checkpoint',
    nodes: [{ id: 'inspect', agent: 'Isolated', prompt: 'Inspect', output: { name: 'out', type: 'note', format: 'text' } }],
  }, { Isolated: {} }).program!;
  const snapshot: PipelineRuntimeSnapshot = {
    runId: 'run-read-only', pipelineId: program.id, status: 'completed',
    nodeStates: { inspect: { status: 'completed', attempts: 1 } }, artifacts: {}, diagnostics: [],
    sandboxRuns: {
      'sandbox-inspect': {
        sandboxName: 'sandbox-inspect', runId: 'run-read-only', nodeId: 'inspect', attempt: 1,
        baseCommit: 'base123', integrationState: 'checkpointed', resourceState: 'removed',
        checkpoint: {
          status: 'checkpointed', commit: 'checkpoint456', remote: 'sandbox-inspect', ref: 'refs/checkpoints/inspect',
          preview: { baseCommit: 'base123', checkpointCommit: 'checkpoint456', fileCount: 1, files: ['forbidden.ts'], diff: 'diff' },
        },
      },
    },
    createdAt: '2026-07-24T10:00:00.000Z', updatedAt: '2026-07-24T10:00:01.000Z',
  };

  const finalized = await runtime.runAgent.finalizePipelineChangeSet!({ runId: snapshot.runId, program, snapshot });

  assert.equal(finalized.promotion, 'no_changes');
  assert.deepEqual(finalized.integratedNodeIds, []);
  assert.equal(calls.some(call => call.command === 'git'), false);
});

test('recovers a durable checkpoint from a terminal-only workspace writer', async () => {
  const calls: SubprocessRequest[] = [];
  const runtime = createWorkspaceRuntime({
    workspaceCwd: '/repo',
    resolvedCatalog: {
      agents: {},
      config: { filePath: '', agents: {}, pipeline: { enabled: true, instructionsMaxBytes: 1, timeouts: {} }, errors: [] },
      errors: [],
    },
    host: {
      permissionContext: () => undefined,
      logger: { log: () => undefined, error: () => undefined },
    },
    sandboxExecutor: async request => {
      calls.push(request);
      const joined = request.args.join(' ');
      if (joined === 'rev-parse refs/checkpoints/terminal') return result('checkpoint456\n');
      if (joined === 'show -s --format=%cI base123') return result('2026-07-24T10:00:00+02:00\n');
      if (request.args[0] === 'merge-tree') return result('tree-terminal\n');
      if (request.args[0] === 'commit-tree') return result('integrated-terminal\n');
      if (request.args[0] === 'diff' && request.args.includes('--name-only')) return result('terminal.ts\n');
      if (request.args[0] === 'diff') return result('diff\n');
      return result();
    },
  });
  const program = compilePipelineV3Definition({
    version: 3, id: 'terminal-writer', title: 'Terminal writer',
    nodes: [{
      id: 'terminal', agent: 'Isolated', prompt: 'Write through terminal',
      policy: { filesystem: 'read-only', terminal: 'workspace-write', promotion: 'discard' },
      output: { name: 'out', type: 'note', format: 'text' },
    }],
  }, { Isolated: {} }).program!;
  const snapshot: PipelineRuntimeSnapshot = {
    runId: 'run-terminal', pipelineId: program.id, status: 'completed',
    nodeStates: { terminal: { status: 'completed', attempts: 1 } }, artifacts: {}, diagnostics: [],
    sandboxRuns: {
      'sandbox-terminal': {
        sandboxName: 'sandbox-terminal', runId: 'run-terminal', nodeId: 'terminal', attempt: 1,
        baseCommit: 'base123', integrationState: 'checkpointed', resourceState: 'removed',
        checkpoint: {
          status: 'checkpointed', commit: 'checkpoint456', remote: 'sandbox-terminal', ref: 'refs/checkpoints/terminal',
          preview: { baseCommit: 'base123', checkpointCommit: 'checkpoint456', fileCount: 1, files: ['terminal.ts'], diff: 'diff' },
        },
      },
    },
    createdAt: '2026-07-24T10:00:00.000Z', updatedAt: '2026-07-24T10:00:01.000Z',
  };

  const finalized = await runtime.runAgent.finalizePipelineChangeSet!({ runId: snapshot.runId, program, snapshot });

  assert.deepEqual(finalized.integratedNodeIds, ['terminal']);
  assert.equal(calls.some(call => call.args[0] === 'merge-tree'), true);
});

test('rejects a persisted active sandbox divergence without relaunching, deleting, or promoting', async () => {
  const calls: SubprocessRequest[] = [];
  const runtime = createWorkspaceRuntime({
    workspaceCwd: '/repo',
    resolvedCatalog: {
      agents: {},
      config: { filePath: '', agents: {}, pipeline: { enabled: true, instructionsMaxBytes: 1, timeouts: {} }, errors: [] },
      errors: [],
    },
    host: {
      permissionContext: () => undefined,
      logger: { log: () => undefined, error: () => undefined },
    },
    sandboxExecutor: async request => {
      calls.push(request);
      if (request.args.join(' ') === 'ls --json') return result('[{"id":"foreign","name":"sandbox-a"}]');
      return result();
    },
  });
  const program = compilePipelineV3Definition({
    version: 3, id: 'diverged', title: 'Diverged',
    nodes: [{ id: 'work', agent: 'Isolated', prompt: 'Work', output: { name: 'out', type: 'note', format: 'text' } }],
  }, { Isolated: {} }).program!;
  const snapshot: PipelineRuntimeSnapshot = {
    runId: 'run-diverged', pipelineId: program.id, status: 'completed',
    nodeStates: { work: { status: 'completed', attempts: 1 } }, artifacts: {}, diagnostics: [],
    sandboxRuns: {
      'sandbox-a': {
        sandboxName: 'sandbox-a', sandboxId: 'expected', runId: 'run-diverged', nodeId: 'work', attempt: 1,
        baseCommit: 'base123', integrationState: 'checkpointed', resourceState: 'active',
        checkpoint: {
          status: 'checkpointed', commit: 'checkpoint456', remote: 'sandbox-sandbox-a', ref: 'refs/checkpoints/a',
          preview: { baseCommit: 'base123', checkpointCommit: 'checkpoint456', fileCount: 1, files: ['a.ts'], diff: 'diff' },
        },
      },
    },
    createdAt: '2026-07-24T10:00:00.000Z', updatedAt: '2026-07-24T10:00:01.000Z',
  };

  await assert.rejects(
    runtime.runAgent.finalizePipelineChangeSet!({ runId: 'run-diverged', program, snapshot }),
    (error: unknown) => (error as { code?: string }).code === 'sandbox_resume_divergence',
  );
  assert.equal(calls.some(call => ['create', 'run', 'rm'].includes(call.args[0] ?? '')), false);
  assert.equal(calls.some(call => call.command === 'git'), false);
});
