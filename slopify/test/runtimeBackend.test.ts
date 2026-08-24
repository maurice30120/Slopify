import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  createRuntimeCliBackend,
  formatPipelineChangeSetPrompt,
  formatRetainedSandbox,
} from '../src/runtimeBackend.js';

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acp-cli-runtime-'));
}

function writeWorkspaceConfig(cwd: string): void {
  const acpRoot = path.join(cwd, '.acp');
  fs.mkdirSync(path.join(acpRoot, 'pipelines'), { recursive: true });
  fs.writeFileSync(path.join(acpRoot, 'acp-agents.json'), JSON.stringify({
    agents: {
      Planner: { command: process.execPath, args: ['--version'] },
    },
    pipeline: { enabled: true },
  }));
  fs.writeFileSync(path.join(acpRoot, 'pipelines', 'plan.yaml'), `
version: 3
id: plan
title: Plan
nodes:
  - id: planner
    agent: Planner
    prompt: Plan {{userPrompt}}
    output:
      name: plan
      type: acp.plan/v1
      format: markdown
`);
}

const context = {
  terminal: {
    async confirm(): Promise<boolean> { return false; },
    async select(): Promise<string | undefined> { return undefined; },
  },
  logger: {
    log(): void {},
    error(): void {},
  },
};

test('creates the standalone CLI backend without loading an editor plugin', () => {
  const cwd = workspace();
  try {
    writeWorkspaceConfig(cwd);

    const backend = createRuntimeCliBackend(cwd, context);

    assert.deepEqual(backend.programs.map(program => program.id), ['plan']);
    assert.equal(typeof backend.runAgent, 'function');
    assert.equal(typeof backend.clearRunLogs, 'function');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('rejects invalid workspace agent configuration before running a pipeline', () => {
  const cwd = workspace();
  try {
    const acpRoot = path.join(cwd, '.acp');
    fs.mkdirSync(acpRoot, { recursive: true });
    fs.writeFileSync(path.join(acpRoot, 'acp-agents.json'), JSON.stringify({ agents: [] }));

    assert.throws(
      () => createRuntimeCliBackend(cwd, context),
      /Invalid workspace ACP configuration/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('formats every retained sandbox command as copyable CLI output', () => {
  assert.equal(formatRetainedSandbox({
    sandboxName: 'slopify-run-node-1-deadbeef',
    commands: {
      run: 'sbx run --name slopify-run-node-1-deadbeef',
      shell: 'sbx exec -it slopify-run-node-1-deadbeef bash',
      remove: 'sbx rm --force slopify-run-node-1-deadbeef',
    },
    diagnosticsPath: '/repo/.acp/logs/sandboxes/slopify-run-node-1-deadbeef.json',
  }), [
    'Docker Sandbox kept: slopify-run-node-1-deadbeef',
    'Run: sbx run --name slopify-run-node-1-deadbeef',
    'Shell: sbx exec -it slopify-run-node-1-deadbeef bash',
    'Remove: sbx rm --force slopify-run-node-1-deadbeef',
    'Diagnostics: /repo/.acp/logs/sandboxes/slopify-run-node-1-deadbeef.json',
  ].join('\n'));
});

test('formats the complete Pipeline Change Set preview for the Promotion decision', () => {
  assert.equal(formatPipelineChangeSetPrompt({
    pipelineId: 'delivery',
    integratedNodeIds: ['plan', 'implement'],
    preview: {
      baseCommit: 'base123',
      changeSetCommit: 'change456',
      fileCount: 2,
      files: ['src/a.ts', 'src/b.ts'],
      diff: 'diff --git a/src/a.ts b/src/a.ts\n+change\n',
    },
  }), [
    'Pipeline Change Set for delivery',
    'Agent checkpoints: plan, implement',
    'Files changed: 2',
    '- src/a.ts',
    '- src/b.ts',
    'Base: base123',
    '',
    'Diff:',
    'diff --git a/src/a.ts b/src/a.ts',
    '+change',
    '',
  ].join('\n'));
});
