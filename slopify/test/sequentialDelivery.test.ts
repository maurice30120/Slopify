import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import type { PipelineRuntimeResult, PipelineRuntimeSnapshot } from '@acp-client/pipeline';

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

test('dispatches one implement-ticket run per ticket before review', async () => {
  const cwd = createDeliveryWorkspace([
    { name: '01-second.md', id: 'T02' },
    { name: '99-first.md', id: 'T01' },
  ]);
  const handoff = deliveryHandoff();
  const starts: Array<{ pipelineName: string; prompt: string }> = [];

  const host = {
    start: async (pipelineName: string, prompt: string): Promise<PipelineRuntimeResult> => {
      starts.push({ pipelineName, prompt });
      if (pipelineName === 'grill-spec-tickets-implement-review') {
        return pausedResult(handoff);
      }
      if (pipelineName === 'implement-ticket') {
        return completedResult('implementation', 'acp.implementation-result/v1', 'ticket complete');
      }
      if (pipelineName === 'review-delivery') {
        return completedResult('review', 'acp.verification-report/v1', 'review complete');
      }
      throw new Error(`Unexpected pipeline ${pipelineName}`);
    },
    resume: async (): Promise<PipelineRuntimeResult> => completedResult(
      'delivery_approval',
      'acp.sequential-delivery/v1',
      handoff,
      'run-main',
      ticketGraph(),
    ),
  };
  const terminal = new FakeTerminal();

  const result = await runPipelineInteractive(host, terminal, command(cwd));

  assert.equal(result.status, 'completed');
  assert.equal(result.artifact?.value, 'review complete');
  assert.deepEqual(starts.map(start => start.pipelineName), [
    'grill-spec-tickets-implement-review',
    'implement-ticket',
    'implement-ticket',
    'review-delivery',
  ]);
  assert.match(starts[1].prompt, /Ticket ID: T01/);
  assert.match(starts[1].prompt, /Ticket: `\.scratch\/feature\/issues\/99-first\.md`/);
  assert.match(starts[2].prompt, /Dependencies: T01/);
  assert.match(starts[2].prompt, /Ticket: `\.scratch\/feature\/issues\/01-second\.md`/);
  assert.match(starts[3].prompt, /Approved delivery files:/);
  assert.match(terminal.errors.join('\n'), /Starting ticket 1\/2/);
  assert.match(terminal.errors.join('\n'), /starting review/);
});

test('fails before child execution when a Ticket Graph node has no Markdown adapter', async () => {
  const cwd = createDeliveryWorkspace([{ name: '02-second.md', id: 'T02' }]);
  const handoff = deliveryHandoff();
  const starts: string[] = [];

  const host = {
    start: async (pipelineName: string): Promise<PipelineRuntimeResult> => {
      starts.push(pipelineName);
      return pausedResult(handoff);
    },
    resume: async (): Promise<PipelineRuntimeResult> => completedResult(
      'delivery_approval',
      'acp.sequential-delivery/v1',
      handoff,
      'run-main',
      ticketGraph(),
    ),
  };
  const terminal = new FakeTerminal();

  const result = await runPipelineInteractive(host, terminal, command(cwd));

  assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'invalid_sequential_delivery');
  assert.match(result.error?.message ?? '', /node "T01" has no Markdown adapter/);
  assert.deepEqual(starts, ['grill-spec-tickets-implement-review']);
});

function createDeliveryWorkspace(tickets: Array<{ name: string; id: string }>): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-sequential-delivery-'));
  const featureDir = path.join(cwd, '.scratch', 'feature');
  const issuesDir = path.join(featureDir, 'issues');
  fs.mkdirSync(issuesDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'spec.md'), '# Specification\n');
  for (const ticket of tickets) {
    fs.writeFileSync(path.join(issuesDir, ticket.name), `# ${ticket.name}\n\n**Ticket ID:** ${ticket.id}\n`);
  }
  return cwd;
}

function deliveryHandoff(): string {
  return [
    '- `.scratch/feature/spec.md`',
    '- `.scratch/feature/issues/`',
  ].join('\n');
}

function pausedResult(handoff: string): PipelineRuntimeResult {
  return {
    status: 'paused',
    runId: 'run-main',
    pause: {
      id: 'approve-delivery',
      nodeId: 'delivery_approval',
      type: 'approval',
      content: handoff,
      format: 'proposed-plan',
      handoff: {
        kind: 'workspace-files',
        minimumReferences: 2,
        layout: 'delivery',
      },
      workspaceGuard: 'documentation-only',
    },
    snapshot: snapshot('paused', 'run-main'),
  };
}

function completedResult(
  producerNodeId: string,
  type: string,
  value: string,
  runId = `run-${producerNodeId}`,
  graph?: unknown,
): PipelineRuntimeResult {
  const completedSnapshot = snapshot('completed', runId);
  if (graph !== undefined) {
    completedSnapshot.artifacts['tasks.ticketGraph'] = {
      name: 'ticketGraph', type: 'acp.ticket-graph/v1', format: 'json', value: graph, producerNodeId: 'tasks',
    };
  }
  return {
    status: 'completed',
    runId,
    artifact: {
      name: producerNodeId === 'review' ? 'report' : 'result',
      type,
      format: 'markdown',
      value,
      producerNodeId,
    },
    snapshot: completedSnapshot,
  };
}

function ticketGraph() {
  return {
    contract: 'acp.ticket-graph/v1',
    tickets: [
      { id: 'T01', title: 'First', scope: ['first'], needs: [], validation: ['first passes'] },
      { id: 'T02', title: 'Second', scope: ['second'], needs: ['T01'], validation: ['second passes'] },
    ],
  };
}

function command(cwd: string): CliRunCommand {
  return {
    kind: 'run',
    pipelineName: 'grill-spec-tickets-implement-review',
    prompt: 'ship feature',
    cwd,
    json: false,
    verbose: false,
    yes: false,
  };
}

function snapshot(status: 'paused' | 'completed', runId: string): PipelineRuntimeSnapshot {
  return {
    runId,
    pipelineId: 'test',
    status,
    nodeStates: {},
    artifacts: {},
    diagnostics: [],
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
  };
}
