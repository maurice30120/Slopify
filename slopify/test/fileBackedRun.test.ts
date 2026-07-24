import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import type { PipelineRuntimeResult } from '@acp-client/pipeline';

import type { CliRunCommand } from '../src/args.js';
import { runPipelineInteractive } from '../src/run.js';
import type { CliTerminal } from '../src/terminal.js';

class FakeTerminal implements CliTerminal {
  readonly output: string[] = [];
  readonly errors: string[] = [];
  readonly confirmations = [true];

  write(message: string): void { this.output.push(message); }
  writeError(message: string): void { this.errors.push(message); }
  async ask(): Promise<string> { return ''; }
  async confirm(): Promise<boolean> { return this.confirmations.shift() ?? false; }
  async select(): Promise<string | undefined> { return undefined; }
  close(): void {}
}

test('shows referenced spec and tickets but approves the compact handoff', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-cli-run-files-'));
  const featureDir = path.join(cwd, '.scratch', 'french-poem');
  const issuesDir = path.join(featureDir, 'issues');
  fs.mkdirSync(issuesDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'spec.md'), '# Approved specification\n\nKeep model context compact.\n');
  fs.writeFileSync(path.join(issuesDir, '01-create-poem.md'), '# Create the poem\n');

  const handoff = [
    '## Documentation',
    '',
    '- `.scratch/french-poem/spec.md`',
    '- `.scratch/french-poem/issues/`',
  ].join('\n');
  const decisions: unknown[] = [];
  const paused: PipelineRuntimeResult = {
    status: 'paused',
    runId: 'run-files',
    pause: {
      id: 'approve-delivery',
      nodeId: 'delivery-approval',
      type: 'approval',
      content: handoff,
      format: 'proposed-plan',
      handoff: { kind: 'workspace-files', minimumReferences: 2, layout: 'delivery' },
    },
    snapshot: snapshot('paused'),
  };
  const completed: PipelineRuntimeResult = {
    status: 'completed',
    runId: 'run-files',
    artifact: {
      name: 'report',
      type: 'acp.verification-report/v1',
      format: 'markdown',
      value: 'review complete',
      producerNodeId: 'review',
    },
    snapshot: snapshot('completed'),
  };
  const host = {
    start: async () => paused,
    resume: async (_runId: string, decision: unknown) => {
      decisions.push(decision);
      return completed;
    },
  };
  const terminal = new FakeTerminal();

  await runPipelineInteractive(host, terminal, command(cwd));

  assert.match(terminal.output[0] ?? '', /# Approved specification/);
  assert.match(terminal.output[0] ?? '', /Keep model context compact\./);
  assert.match(terminal.output[0] ?? '', /# Create the poem/);
  assert.deepEqual(decisions, [{
    pauseId: 'approve-delivery',
    kind: 'approve',
    value: handoff,
  }]);
});

test('fails before approval when a required workspace handoff has no files', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-cli-run-files-'));
  const paused: PipelineRuntimeResult = {
    status: 'paused',
    runId: 'run-invalid-files',
    pause: {
      id: 'approve-delivery',
      nodeId: 'delivery-approval',
      type: 'approval',
      content: [
        '<proposed_plan>',
        '<interview_state>ready</interview_state>',
        '</proposed_plan>',
      ].join('\n'),
      format: 'proposed-plan',
      handoff: { kind: 'workspace-files', minimumReferences: 2, layout: 'delivery' },
    },
    snapshot: snapshot('paused', 'run-invalid-files'),
  };
  let resumed = false;
  const host = {
    start: async () => paused,
    resume: async () => {
      resumed = true;
      throw new Error('resume must not be called');
    },
  };
  const terminal = new FakeTerminal();

  const result = await runPipelineInteractive(host, terminal, command(cwd));

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'invalid_workspace_handoff');
  assert.equal(resumed, false);
  assert.match(terminal.errors[0] ?? '', /requires at least 2 existing \.scratch Markdown reference/);
});

function command(cwd: string): CliRunCommand {
  return {
    kind: 'run',
    pipelineName: 'file-backed',
    prompt: 'simplify context',
    cwd,
    json: false,
    verbose: false,
    yes: false,
  };
}

function snapshot(status: 'paused' | 'completed', runId = 'run-files') {
  return {
    runId,
    pipelineId: 'file-backed',
    status,
    nodeStates: {},
    artifacts: {},
    diagnostics: [],
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
  };
}
