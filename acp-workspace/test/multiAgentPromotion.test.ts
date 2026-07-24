import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { compilePipelineV3Definition } from '@acp-client/pipeline';
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
      requestPromotion: async () => 'cancelled',
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
      if (joined === 'policy init --help') return result('Usage: sbx policy init');
      return result();
    },
  });

  const program = compilePipelineV3Definition({
    version: 3,
    id: 'multi-agent',
    title: 'Multi-agent',
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
    ],
  }, { Isolated: {} }).program!;

  await Promise.all([
    runtime.runAgent({
      workspaceCwd: cwd, agentName: 'Isolated', runId: 'run-1', nodeId: 'b', attempt: 1,
      promptText: 'B', sideEffects: 'workspace', promotion: 'ask',
    }),
    runtime.runAgent({
      workspaceCwd: cwd, agentName: 'Isolated', runId: 'run-1', nodeId: 'a', attempt: 1,
      promptText: 'A', sideEffects: 'workspace', promotion: 'ask',
    }),
  ]);

  assert.equal(calls.some(call => call.command === 'git' && call.args[0] === 'merge'), false);
  const finalized = await runtime.runAgent.finalizePipelineChangeSet!({ runId: 'run-1', program });

  assert.equal(finalized.promotion, 'applied');
  assert.deepEqual(finalized.integratedNodeIds, ['a', 'b']);
  assert.equal(promotionPrompts, 1);
  assert.deepEqual(
    calls.filter(call => call.command === 'git' && call.args[0] === 'merge-tree').map(call => call.args.at(-1)?.includes('-a-') ? 'a' : 'b'),
    ['a', 'b'],
  );
  assert.deepEqual(
    calls.filter(call => call.command === 'git' && call.args[0] === 'merge').map(call => call.args),
    [['merge', '--ff-only', '--no-edit', finalized.changeSetRef]],
  );
});

test('integrates the highest checkpoint attempt and cleans up superseded attempt refs', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-workspace-retry-'));
  const calls: SubprocessRequest[] = [];
  const runtime = createWorkspaceRuntime({
    workspaceCwd: cwd,
    resolvedCatalog: {
      agents: { Isolated: { transport: 'sandbox', agent: 'codex', model: 'gpt-5.6-codex' } },
      native: {
        filePath: path.join(cwd, '.acp', 'acp-agents.json'),
        agents: {},
        pipeline: { enabled: true, instructionsMaxBytes: 256 * 1024, timeouts: {} },
        errors: [],
      },
      sandcastle: {
        filePath: path.join(cwd, '.acp', '.sandcastle', 'config.json'),
        promotion: 'ask',
        agents: {},
        errors: [],
      },
      errors: [],
    },
    host: {
      permissionContext: () => undefined,
      requestPromotion: async () => 'cancelled',
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
