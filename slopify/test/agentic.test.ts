import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { compilePipelineV3Definition, workspacePipelineRunStore, type PipelineRuntimeSnapshot } from '@acp-client/pipeline';
import { loadWorkspacePipelinePrograms } from '@acp-client/workspace';
import { readPipelineCatalog, readLaunchBrief } from '../src/catalog.js';
import { parseCliArgs } from '../src/args.js';
import { inspectRun, readRunLogs } from '../src/inspection.js';
import { acquireCliLease } from '../src/lease.js';
import { CliProgress } from '../src/progress.js';
import { CliPipelineHost } from '../src/host.js';
import type { CliTerminal } from '../src/terminal.js';

const terminal: CliTerminal = { write() {}, writeError() {}, async ask() { return ''; }, async confirm() { return false; }, async select() { return undefined; }, close() {} };
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'slopify-agentic-'));
  mkdirSync(join(cwd, '.acp'));
  const compiled = compilePipelineV3Definition({ version: 3, id: 'small', title: 'Small', nodes: [{ id: 'work', agent: 'fake', prompt: '{{userPrompt}}', output: { name: 'result', type: 'test/result', format: 'markdown' } }] }, { fake: {} });
  assert.ok(compiled.program);
  const programs = [compiled.program];
  const manifest = { contract: 'slopify.pipeline-catalog/v1', version: '1', pipelines: [{ id: 'small', intention: 'Local change', steps: ['work'], prerequisites: ['brief'], capabilities: ['implementation'], results: ['result'], approximateCost: 'low' }] };
  writeFileSync(join(cwd, '.acp/pipeline-catalog.json'), JSON.stringify(manifest));
  const catalog = readPipelineCatalog(cwd, programs);
  const brief = { contract: 'slopify.launch-brief/v1', objective: 'Local change', scope: ['module'], constraints: [], acceptanceCriteria: ['works'], decisions: [], confirmation: { confirmed: true, at: new Date().toISOString() }, selection: { pipeline: 'small', criteria: ['local'], catalogVersion: catalog.version, catalogDigest: catalog.digest } };
  const file = join(cwd, 'brief.json');
  writeFileSync(file, JSON.stringify(brief));
  return { cwd, file, brief, programs, manifest };
}

test('catalogue rejects unavailable and duplicate pipelines; brief requires confirmation and preserves explicit selection', () => {
  const { cwd, programs, manifest, brief, file } = fixture();
  assert.equal(readLaunchBrief(file).objective, 'Local change');
  writeFileSync(file, JSON.stringify({ ...brief, confirmation: { confirmed: false, at: brief.confirmation.at } }));
  assert.throws(() => readLaunchBrief(file), /unconfirmed/);
  writeFileSync(file, JSON.stringify({ ...brief, selection: { ...brief.selection, requestedPipeline: 'large' } }));
  assert.throws(() => readLaunchBrief(file), /explicitly requested/);
  writeFileSync(join(cwd, '.acp/pipeline-catalog.json'), JSON.stringify({ ...manifest, pipelines: [...manifest.pipelines, ...manifest.pipelines] }));
  assert.throws(() => readPipelineCatalog(cwd, programs), /Duplicate/);
  assert.throws(() => readPipelineCatalog(cwd, []), /unavailable/);
});

test('confirmed selection is persisted; changed catalogue fails before preflight', async () => {
  const { cwd, programs, file, manifest } = fixture();
  let preflights = 0;
  const host = new CliPipelineHost(cwd, { terminal, backendFactory: () => ({ programs, preflightPipeline: async () => { preflights++; }, runAgent: async () => 'done' }) });
  try {
    const result = await host.start('small', '', file);
    const inspection = await inspectRun(cwd, result.runId);
    assert.equal(inspection.snapshot.inputVariables?.selection !== undefined, true);
    assert.equal(inspection.snapshot.status, 'completed');
    writeFileSync(join(cwd, '.acp/pipeline-catalog.json'), JSON.stringify({ ...manifest, version: '2' }));
    await assert.rejects(() => host.start('small', '', file), /does not match/);
    assert.equal(preflights, 1);
  } finally { await host.dispose(); }
});

test('inspection and logs survive reconstruction; active CLI suppresses unsafe supervision', async () => {
  const { cwd } = fixture();
  const store = workspacePipelineRunStore(cwd);
  const snapshot: PipelineRuntimeSnapshot = { runId: 'r', pipelineId: 'small', status: 'paused', inputVariables: {}, nodeStates: {}, artifacts: {}, diagnostics: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await store.create(snapshot);
  await store.appendEvent('r', { runId: 'r', type: 'paused', at: snapshot.updatedAt });
  assert.deepEqual((await inspectRun(cwd, 'r')).actions.map(action => action.kind), ['resume', 'cancel']);
  const release = acquireCliLease(cwd);
  try {
    assert.throws(() => acquireCliLease(cwd), /already owns/);
    assert.deepEqual((await inspectRun(cwd, 'r')).actions, []);
    assert.equal((await readRunLogs(cwd, 'r')).events.length, 1);
  } finally { release(); }
  assert.equal((await inspectRun(cwd, 'r')).ownerActive, false);
});

test('progress coalesces bursts and a heartbeat does not invent advancement', () => {
  let now = 0;
  const lines: string[] = [];
  const view = new CliProgress({ ...terminal, writeError: line => lines.push(line) }, () => now);
  try {
    view.accept({ runId: 'r', nodeId: 'a', type: 'node_started', at: '' });
    const activity = { kind: 'status' as const, content: 'Implement', progress: { action: 'Implement', target: 'a.ts', result: '', next: '', source: 'agent' as const } };
    view.accept({ runId: 'r', nodeId: 'a', type: 'agent_activity', activity, at: '' });
    assert.equal(lines.length, 1);
    now = 1000;
    view.flush();
    assert.match(lines[1], /Implement · a.ts/);
    now = 61_000;
    view.flush();
    assert.match(lines[2], /aucune nouvelle activité/);
  } finally { view.close(); }
});

test('CLI accepts inspection, supervision and brief files while rejecting mixed prompt and brief', () => {
  assert.equal(parseCliArgs(['catalog', '--json']).kind, 'catalog');
  assert.equal(parseCliArgs(['inspect', 'r', '--json']).kind, 'inspect');
  assert.equal(parseCliArgs(['retry', 'r', 'node']).kind, 'retry');
  assert.equal(parseCliArgs(['run', 'quick', '--brief', 'brief.json']).kind, 'run');
  assert.throws(() => parseCliArgs(['run', 'quick', 'prompt', '--brief', 'brief.json']));
  assert.throws(() => parseCliArgs(['inspect', 'r', '--yes']));
});

test('repository quick, standard and full compile and are discoverable through their catalogue', () => {
  const cwd = resolve('..');
  const agents = JSON.parse(readFileSync(join(cwd, '.acp/acp-agents.json'), 'utf8')).agents;
  const result = loadWorkspacePipelinePrograms(cwd, agents);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(readPipelineCatalog(cwd, result.programs).pipelines.map(entry => entry.id), ['quick', 'standard', 'full']);
});
