import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createWorkspaceRuntime } from '../src/index.js';
import type { SubprocessRequest, SubprocessResult } from '@acp-client/sandbox';

function response(stdout = '', stderr = '', exitCode = 0): SubprocessResult {
  return { exitCode, stdout, stderr };
}

test('workspace CLI presents the exact global Docker network choices and reports later management', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-network-policy-'));
  fs.mkdirSync(path.join(cwd, '.acp'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.acp', 'acp-agents.json'), JSON.stringify({ agents: {
    Isolated: { transport: 'sandbox', agent: 'codex', model: 'gpt-5.6-codex' },
  } }));

  const calls: SubprocessRequest[] = [];
  const selections: Array<{ title: string; options: string[] }> = [];
  const messages: string[] = [];
  const runtime = createWorkspaceRuntime({
    workspaceCwd: cwd,
    host: {
      permissionContext: () => ({
        hasUI: true,
        ui: {
          select: async (title, options) => {
            selections.push({ title, options });
            return 'Balanced';
          },
          confirm: async () => false,
          write: message => messages.push(message),
        },
      }),
      requestPromotion: async () => 'cancelled',
      logger: { log: () => undefined, error: () => undefined },
    },
    sandboxExecutor: async request => {
      calls.push(request);
      return fakeSandboxResponse(request);
    },
  });

  await runtime.runAgent({
    workspaceCwd: cwd,
    agentName: 'Isolated',
    runId: 'run-policy',
    nodeId: 'inspect',
    attempt: 1,
    promptText: 'Inspect the repository.',
    sideEffects: 'none',
  });

  assert.equal(selections.length, 1);
  assert.match(selections[0].title, /global network policy.*every Sandbox Run/i);
  assert.deepEqual(selections[0].options, ['Open', 'Balanced', 'Locked Down']);
  assert.equal(calls.filter(call => call.args.join(' ') === 'policy init balanced').length, 1);
  assert.match(messages.join('\n'), /Balanced.*sbx policy/);
  assert.equal(calls.some(call => call.args.includes('--sandbox')), false);
});

function fakeSandboxResponse(request: SubprocessRequest): SubprocessResult {
  if (request.command === 'git' && request.args.join(' ') === 'rev-parse --is-inside-work-tree') return response('true\n');
  if (request.command === 'git' && request.args.join(' ') === 'rev-parse HEAD') return response('base123\n');
  if (request.command === 'git' && request.args[0] === 'rev-parse') return response('checkpoint456\n');
  if (request.command === 'git' && request.args[0] === 'status') return response();
  if (request.command === 'git' && request.args[0] === 'diff') return response();
  if (request.command === 'git' && request.args[0] === 'fetch') return response();
  if (request.args.join(' ') === 'version') return response('sbx 0.35.0\n');
  if (request.args.join(' ') === 'create --help') return response('--clone\n');
  if (request.args.join(' ') === 'ls --help') return response('--json\n');
  if (request.args.join(' ') === 'policy init --help') return response('Usage: sbx policy init\n');
  if (request.args.join(' ') === 'policy ls --json') return response('', 'policy is not initialized', 1);
  return response();
}
