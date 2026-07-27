import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadAgentCatalog,
  loadPipelineProgramsFromRoot,
  parseAcpConfig,
  createWorkspaceRuntime,
  createWorkspaceRun,
  removeAgentConfig,
  upsertAgentConfig,
} from '../src/index.js';
import type { PipelineRuntimeResult } from '@acp-client/pipeline';
import type { SubprocessRequest, SubprocessResult } from '@acp-client/sandbox';

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acp-workspace-'));
}

test('public entry point parses native configuration', () => {
  const config = parseAcpConfig(JSON.stringify({ agents: { Codex: { command: 'codex', args: ['acp'] } } }));
  assert.equal('command' in config.agents.Codex ? config.agents.Codex.command : undefined, 'codex');
  assert.deepEqual(config.errors, []);
});

test('accepts only Codex for the sandbox transport with corrective errors', () => {
  const accepted = parseAcpConfig(JSON.stringify({ agents: {
    Isolated: { transport: 'sandbox', agent: 'codex', model: 'gpt-5.6-codex', effort: 'high' },
  } }));
  assert.deepEqual(accepted.errors, []);
  assert.equal(accepted.agents.Isolated.transport, 'sandbox');

  const rejected = parseAcpConfig(JSON.stringify({ agents: {
    Other: { transport: 'sandbox', agent: 'pi', model: 'pi-model' },
  } }));
  assert.equal(rejected.agents.Other, undefined);
  assert.match(rejected.errors.join('\n'), /must be "codex".*other Docker Sandbox agents are not supported yet/);
});

test('writes and removes agents in the single ACP catalogue while preserving its envelope', () => {
  const cwd = workspace();
  fs.mkdirSync(path.join(cwd, '.acp'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.acp', 'acp-agents.json'), JSON.stringify({ pipeline: { enabled: false }, agents: {} }));

  upsertAgentConfig('Agent', { command: 'agent' }, cwd);
  const nativeAgent = loadAgentCatalog(cwd).config.agents.Agent;
  assert.equal('command' in nativeAgent ? nativeAgent.command : undefined, 'agent');
  upsertAgentConfig('Agent', { transport: 'sandbox', agent: 'codex', model: 'gpt-5', effort: 'high' }, cwd);
  const moved = loadAgentCatalog(cwd);
  assert.equal(moved.config.agents.Agent.transport, 'sandbox');
  removeAgentConfig('Agent', cwd);
  assert.equal(loadAgentCatalog(cwd).agents.Agent, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, '.acp', 'acp-agents.json'), 'utf8')).pipeline.enabled, false);
  assert.equal(fs.existsSync(path.join(cwd, '.acp', '.sandcastle', 'config.json')), false);
});

test('legacy isolated-agent configuration fails with an explicit manual migration error', () => {
  const cwd = workspace();
  fs.mkdirSync(path.join(cwd, '.acp', '.sandcastle'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.acp', 'acp-agents.json'), JSON.stringify({
    agents: { Current: { transport: 'sandbox', agent: 'codex', model: 'gpt-5.6-codex' } },
  }));
  fs.writeFileSync(path.join(cwd, '.acp', '.sandcastle', 'config.json'), JSON.stringify({
    agents: { Legacy: { transport: 'sandcastle', provider: 'codex', model: 'gpt-5' } },
  }));

  const catalog = loadAgentCatalog(cwd);

  assert.deepEqual(Object.keys(catalog.agents), ['Current']);
  const error = catalog.errors.join('\n');
  assert.match(error, /\.acp\/\.sandcastle\/config\.json/);
  assert.match(error, /no longer supported/i);
  assert.match(error, /transport: "sandbox"/);
  assert.match(error, /migrate manually/i);
  assert.match(error, /remove.*\.acp\/\.sandcastle\/config\.json/i);
});

test('WorkspaceRuntime completes the Codex Docker Sandbox tracer path as no_changes with a fake sbx executor', async () => {
  const cwd = workspace();
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
      return fakeSandboxResponse(request);
    },
  });

  const outcome = await runtime.runAgent({
    workspaceCwd: cwd, agentName: 'Isolated', runId: 'run-7', nodeId: 'verify', attempt: 1,
    promptText: 'Inspect without changing files.', sideEffects: 'workspace',
  });

  assert.deepEqual(outcome, { text: '', promotion: 'no_changes' });
  assert.ok(calls.some(call => call.args[0] === 'create' && call.args.includes('--clone')));
  assert.deepEqual(calls.at(-1)?.args.slice(0, 2), ['rm', '--force']);
});

test('public pipeline catalog resolves instructionsFile and keeps promptFile compatibility', () => {
  const cwd = workspace();
  const pipelines = path.join(cwd, '.acp', 'pipelines');
  const agents = path.join(cwd, '.acp', 'agents');
  fs.mkdirSync(pipelines, { recursive: true });
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'planner.md'), 'Invariant planner instructions.');
  fs.writeFileSync(path.join(agents, 'legacy.md'), 'Legacy complete prompt.');
  fs.writeFileSync(path.join(pipelines, 'structured.yaml'), `version: 3
id: structured
title: Structured
nodes:
  - id: plan
    agent: Codex
    instructionsFile: ../agents/planner.md
    prompt: Run-specific task.
    output: { name: plan, type: acp.plan/v1, format: markdown }
`);
  fs.writeFileSync(path.join(pipelines, 'legacy.yaml'), `version: 3
id: legacy
title: Legacy
nodes:
  - id: plan
    agent: Codex
    promptFile: ../agents/legacy.md
    output: { name: plan, type: acp.plan/v1, format: markdown }
`);

  const result = loadPipelineProgramsFromRoot({
    workspaceCwd: cwd,
    configRoot: cwd,
    agentConfigs: { Codex: { command: 'codex' } },
  });

  assert.deepEqual(result.errors, []);
  const structured = result.programs.find(program => program.id === 'structured')?.nodes[0];
  assert.equal(structured?.prompt, 'Run-specific task.');
  assert.equal(structured?.promptFile, 'Invariant planner instructions.');
  const legacy = result.programs.find(program => program.id === 'legacy')?.nodes[0];
  assert.equal(legacy?.prompt, 'Legacy complete prompt.');
  assert.equal(legacy?.promptFile, undefined);
});

test('hosts do not import workspace catalogues from the low-level runtime', () => {
  const repo = path.resolve(import.meta.dirname, '..', '..', '..');
  for (const host of ['slopify/src']) {
    for (const file of walk(path.join(repo, host))) {
      if (!file.endsWith('.ts')) continue;
      const source = fs.readFileSync(file, 'utf8');
      const runtimeImports = [...source.matchAll(/import[\s\S]*?from ['"]@acp-client\/runtime['"]/g)].map(match => match[0]);
      for (const statement of runtimeImports) {
        assert.doesNotMatch(statement, /load(?:AcpConfig|AgentCatalog|PipelineProgramsFromRoot|SkillCatalog)/, file);
      }
    }
  }
});

test('WorkspaceRuntime exposes only the deep run interface', () => {
  const cwd = workspace();
  fs.mkdirSync(path.join(cwd, '.acp'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.acp', 'acp-agents.json'), JSON.stringify({ agents: {} }));
  const runtime = createWorkspaceRuntime({
    workspaceCwd: cwd,
    host: {
      permissionContext: () => undefined,
      logger: { log: () => undefined, error: () => undefined },
    },
  });
  assert.deepEqual(Object.keys(runtime).sort(), ['clearRunLogs', 'programs', 'runAgent']);
});

test('low-level runtime has no workspace, Pipeline V3, or isolated-runtime ownership', () => {
  const repo = path.resolve(import.meta.dirname, '..', '..', '..');
  const runtimeRoot = path.join(repo, 'acp-runtime');
  const manifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['@acp-client/pipeline'], undefined);
  const removedPackage = `@acp-client/${['sand', 'castle'].join('')}`;
  assert.equal(manifest.dependencies[removedPackage], undefined);
  const legacyCatalog = path.join(runtimeRoot, 'src', 'catalog');
  assert.equal(fs.existsSync(legacyCatalog) ? walk(legacyCatalog).some(file => file.endsWith('.ts')) : false, false);
  for (const file of walk(path.join(runtimeRoot, 'src'))) {
    if (!file.endsWith('.ts')) continue;
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /@acp-client\/pipeline/, file);
    assert.doesNotMatch(source, /(?:\.acp|\.scratch)\//, file);
  }
});

test('WorkspaceRun validates a typed delivery handoff and runs tickets sequentially', async () => {
  const cwd = workspace();
  const feature = path.join(cwd, '.scratch', 'feature');
  fs.mkdirSync(path.join(feature, 'issues'), { recursive: true });
  fs.writeFileSync(path.join(feature, 'spec.md'), '# Spec\n');
  fs.writeFileSync(path.join(feature, 'issues', '01-first.md'), '# First\n');
  fs.writeFileSync(path.join(feature, 'issues', '02-second.md'), '# Second\n');
  const starts: Array<{ pipelineName: string; prompt: string }> = [];
  const run = createWorkspaceRun({
    workspaceCwd: cwd,
    start: async (pipelineName, prompt) => {
      starts.push({ pipelineName, prompt });
      if (pipelineName === 'delivery') return completedResult(content, 'acp.sequential-delivery/v1');
      return completedResult(pipelineName === 'review-delivery' ? 'review complete' : 'ticket complete');
    },
    resume: async () => { throw new Error('not paused'); },
  });
  const content = '- `.scratch/feature/spec.md`\n- `.scratch/feature/issues/`';
  const final = await run.start('delivery', 'ship it');

  assert.deepEqual(starts.map(start => start.pipelineName), [
    'delivery', 'implement-ticket', 'implement-ticket', 'review-delivery',
  ]);
  assert.equal(final.status, 'completed');
  assert.equal(final.status === 'completed' ? final.artifact?.value : undefined, 'review complete');
});

test('WorkspaceRun rejects an invalid typed handoff before a host can approve it', async () => {
  const cwd = workspace();
  const run = createWorkspaceRun({
    workspaceCwd: cwd,
    start: async () => ({
      status: 'paused', runId: 'run-invalid',
      pause: {
        id: 'approval', nodeId: 'delivery', type: 'approval',
        content: '- `.scratch/missing/spec.md`', format: 'markdown',
        handoff: { kind: 'workspace-files', minimumReferences: 2, layout: 'delivery' },
      },
      snapshot: runtimeSnapshot('paused'),
    }),
    resume: async () => { throw new Error('invalid handoff must not resume'); },
  });
  const outcome = await run.start('delivery', 'ship');

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.status === 'failed' ? outcome.error.code : '', 'invalid_workspace_handoff');
  assert.match(outcome.status === 'failed' ? outcome.error.message : '', /does not exist/);
});

test('Pipeline definitions and CLI contain no hidden slopify handoff protocol', () => {
  const repo = path.resolve(import.meta.dirname, '..', '..', '..');
  for (const root of ['slopify/src']) {
    for (const file of walk(path.join(repo, root))) {
      const source = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /slopify:/, file);
    }
  }
  for (const legacy of ['sequentialDelivery.ts', 'workspaceArtifacts.ts', 'preImplementationGuard.ts']) {
    assert.equal(fs.existsSync(path.join(repo, 'slopify', 'src', legacy)), false);
  }
});

test('WorkspaceRun exposes normalized interactions instead of Pipeline runtime snapshots', async () => {
  const cwd = workspace();
  const run = createWorkspaceRun({
    workspaceCwd: cwd,
    start: async () => ({
      status: 'paused', runId: 'run-1',
      pause: { id: 'pause-1', nodeId: 'question', type: 'question', content: 'Which API?', format: 'markdown' },
      snapshot: runtimeSnapshot('paused'),
    }),
    resume: async (_runId, decision) => {
      assert.deepEqual(decision, { pauseId: 'pause-1', kind: 'answer', value: 'public' });
      return completedResult('done');
    },
  });

  const paused = await run.start('pipeline', 'ship');
  assert.deepEqual(paused, {
    status: 'interaction-required', runId: 'run-1',
    interaction: { id: 'pause-1', nodeId: 'question', kind: 'question', content: 'Which API?', format: 'markdown' },
  });
  const completed = await run.respond('run-1', { interactionId: 'pause-1', kind: 'answer', value: 'public' });
  assert.equal(completed.status, 'completed');
  assert.equal('snapshot' in completed, false);
});

function completedResult(value: string, type = 'acp.result/v1'): PipelineRuntimeResult {
  return {
    status: 'completed',
    runId: 'run',
    artifact: { name: 'result', type, format: 'markdown', value, producerNodeId: 'node' },
    snapshot: {
      runId: 'run', pipelineId: 'test', status: 'completed', nodeStates: {}, artifacts: {}, diagnostics: [],
      createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z',
    },
  };
}

function runtimeSnapshot(status: 'paused' | 'completed') {
  return {
    runId: 'run-1', pipelineId: 'test', status, nodeStates: {}, artifacts: {}, diagnostics: [],
    createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z',
  };
}

function fakeSandboxResponse(request: SubprocessRequest): SubprocessResult {
  if (request.command === 'git' && request.args[0] === 'rev-parse') return { exitCode: 0, stdout: 'true\n', stderr: '' };
  if (request.args.join(' ') === 'version') return { exitCode: 0, stdout: 'sbx 0.35.0\n', stderr: '' };
  if (request.args.join(' ') === 'create --help') return { exitCode: 0, stdout: '--clone\n', stderr: '' };
  if (request.args.join(' ') === 'ls --help') return { exitCode: 0, stdout: '--json\n', stderr: '' };
  return { exitCode: 0, stdout: '', stderr: '' };
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}
