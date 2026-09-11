import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  synthesizeTicketGraphArtifact,
  upsertAgentConfig,
} from '../src/index.js';
import type { PipelineArtifact, PipelineRuntimeResult } from '@acp-client/pipeline';
import type { SubprocessRequest, SubprocessResult } from '@acp-client/sandbox';

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acp-workspace-'));
}

test('public entry point parses native configuration', () => {
  const config = parseAcpConfig(JSON.stringify({ agents: { Codex: { command: 'codex', args: ['acp'] } } }));
  assert.equal('command' in config.agents.Codex ? config.agents.Codex.command : undefined, 'codex');
  assert.deepEqual(config.errors, []);
});

test('ships Vibe and Vibe Sandbox in the workspace and bundled ACP catalogues', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const configPaths = [
    path.join(repoRoot, '.acp', 'acp-agents.json'),
    path.join(repoRoot, 'slopify', 'default-agents.json'),
  ];

  for (const configPath of configPaths) {
    const config = parseAcpConfig(fs.readFileSync(configPath, 'utf8'), configPath);
    assert.deepEqual(config.agents.Vibe, {
      transport: 'acp',
      command: 'vibe-acp',
      args: [],
      env: {},
    });
    assert.deepEqual(config.agents['Vibe Sandbox'], {
      transport: 'sandbox',
      agent: 'vibe',
      model: 'mistral-medium-3.5',
      kit: './.sbx/vibe',
    });
    assert.deepEqual(config.errors, []);
  }
});

test('ships Copilot Sandbox in the bundled ACP catalogue', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const configPath = path.join(repoRoot, 'slopify', 'default-agents.json');
  const config = parseAcpConfig(fs.readFileSync(configPath, 'utf8'), configPath);

  assert.deepEqual(config.agents['Copilot Sandbox'], {
    transport: 'sandbox',
    agent: 'copilot',
    model: 'auto',
    displayName: 'GitHub Copilot CLI',
  });
  assert.deepEqual(config.errors, []);
});

test('accepts Vibe for the sandbox transport when a Docker Sandbox kit is configured', () => {
  const accepted = parseAcpConfig(JSON.stringify({ agents: {
    'Vibe Sandbox': {
      transport: 'sandbox',
      agent: 'vibe',
      model: 'mistral-medium-3.5',
      kit: './.sbx/vibe',
    },
  } }));
  assert.deepEqual(accepted.errors, []);
  assert.deepEqual(accepted.agents['Vibe Sandbox'], {
    transport: 'sandbox',
    agent: 'vibe',
    model: 'mistral-medium-3.5',
    kit: './.sbx/vibe',
  });

  const missingKit = parseAcpConfig(JSON.stringify({ agents: {
    Vibe: { transport: 'sandbox', agent: 'vibe', model: 'mistral-medium-3.5' },
  } }));
  assert.equal(missingKit.agents.Vibe, undefined);
  assert.match(missingKit.errors.join('\n'), /agents\.Vibe\.kit must be a non-empty string for the Vibe sandbox agent/);
});

test('accepts Codex and OpenCode for the sandbox transport with corrective errors', () => {
  const acceptedCodex = parseAcpConfig(JSON.stringify({ agents: {
    Isolated: { transport: 'sandbox', agent: 'codex', model: 'gpt-5.6-codex', effort: 'high' },
  } }));
  assert.deepEqual(acceptedCodex.errors, []);
  assert.equal(acceptedCodex.agents.Isolated.transport, 'sandbox');
  assert.equal(acceptedCodex.agents.Isolated.agent, 'codex');

  const opencodeConfig = {
    provider: {
      'opencode-go': {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: 'https://opencode.ai/zen/go/v1', apiKey: '{env:OPENCODE_GO_API_KEY}' },
      },
    },
  };
  const acceptedOpencode = parseAcpConfig(JSON.stringify({ agents: {
    Isolated: { transport: 'sandbox', agent: 'opencode', model: 'opencode-go/glm-5.2', opencodeConfig },
  } }));
  assert.deepEqual(acceptedOpencode.errors, []);
  assert.equal(acceptedOpencode.agents.Isolated.transport, 'sandbox');
  assert.equal(acceptedOpencode.agents.Isolated.agent, 'opencode');
  assert.deepEqual(acceptedOpencode.agents.Isolated.opencodeConfig, opencodeConfig);

  const rejectedOnCodex = parseAcpConfig(JSON.stringify({ agents: {
    WithConfig: { transport: 'sandbox', agent: 'codex', model: 'gpt-5.6-codex', opencodeConfig },
  } }));
  assert.equal(rejectedOnCodex.agents.WithConfig, undefined);
  assert.match(rejectedOnCodex.errors.join('\n'), /agents\.WithConfig\.opencodeConfig is only supported for agent "opencode"/);

  const rejectedShape = parseAcpConfig(JSON.stringify({ agents: {
    BadShape: { transport: 'sandbox', agent: 'opencode', model: 'opencode-go/glm-5.2', opencodeConfig: ['nope'] },
  } }));
  assert.equal(rejectedShape.agents.BadShape, undefined);
  assert.match(rejectedShape.errors.join('\n'), /agents\.BadShape\.opencodeConfig must be an object/);

  const rejected = parseAcpConfig(JSON.stringify({ agents: {
    Other: { transport: 'sandbox', agent: 'pi', model: 'pi-model' },
  } }));
  assert.equal(rejected.agents.Other, undefined);
  assert.match(rejected.errors.join('\n'), /must be "codex", "opencode", "vibe", or "copilot".*other Docker Sandbox agents are not supported yet/);
});

test('accepts Copilot for the sandbox transport', () => {
  const accepted = parseAcpConfig(JSON.stringify({ agents: {
    'Copilot Sandbox': { transport: 'sandbox', agent: 'copilot', model: 'auto' },
  } }));

  assert.deepEqual(accepted.errors, []);
  assert.deepEqual(accepted.agents['Copilot Sandbox'], {
    transport: 'sandbox',
    agent: 'copilot',
    model: 'auto',
  });
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
  assert.deepEqual(Object.keys(runtime).sort(), ['clearRunLogs', 'preflightPipeline', 'programs', 'restoreProgram', 'runAgent']);
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

test('WorkspaceRun uses Ticket Graph identities and dependencies regardless of Markdown file order', async () => {
  const cwd = workspace();
  const feature = path.join(cwd, '.scratch', 'feature');
  fs.mkdirSync(path.join(feature, 'issues'), { recursive: true });
  fs.writeFileSync(path.join(feature, 'spec.md'), '# Spec\n');
  fs.writeFileSync(path.join(feature, 'issues', '01-second.md'), '# Second\n\n**Ticket ID:** T02\n');
  fs.writeFileSync(path.join(feature, 'issues', '99-first.md'), '# First\n\n**Ticket ID:** T01\n');
  const starts: Array<{ pipelineName: string; prompt: string }> = [];
  const run = createWorkspaceRun({
    workspaceCwd: cwd,
    start: async (pipelineName, prompt) => {
      starts.push({ pipelineName, prompt });
      if (pipelineName === 'delivery') return completedDeliveryResult(content, {
        contract: 'acp.ticket-graph/v1',
        tickets: [
          { id: 'T02', title: 'Second', scope: ['second'], needs: ['T01'], validation: ['second passes'] },
          { id: 'T01', title: 'First', scope: ['first'], needs: [], validation: ['first passes'] },
        ],
      });
      return completedResult(pipelineName === 'review-delivery' ? 'review complete' : 'ticket complete');
    },
    resume: async () => { throw new Error('not paused'); },
  });
  const content = '- `.scratch/feature/spec.md`\n- `.scratch/feature/issues/`';
  const final = await run.start('delivery', 'ship it');

  assert.deepEqual(starts.map(start => start.pipelineName), [
    'delivery', 'implement-ticket', 'implement-ticket', 'review-delivery',
  ]);
  assert.match(starts[1].prompt, /Ticket ID: T01/);
  assert.match(starts[1].prompt, /Human-readable ticket: `\.scratch\/feature\/issues\/99-first\.md`/);
  assert.match(starts[1].prompt, /Dependencies: None/);
  assert.match(starts[1].prompt, /"scope": \[\s*"first"\s*\]/);
  assert.match(starts[2].prompt, /Ticket ID: T02/);
  assert.match(starts[2].prompt, /Human-readable ticket: `\.scratch\/feature\/issues\/01-second\.md`/);
  assert.match(starts[2].prompt, /Dependencies: T01/);
  assert.equal(final.status, 'completed');
  assert.equal(final.status === 'completed' ? final.artifact?.value : undefined, 'review complete');
});

test('WorkspaceRun reconstructs a missing Ticket Graph after document Promotion', async () => {
  const cwd = workspace();
  const feature = path.join(cwd, '.scratch', 'feature');
  const issues = path.join(feature, 'issues');
  fs.mkdirSync(issues, { recursive: true });
  fs.writeFileSync(path.join(feature, 'spec.md'), '# Spec\n');
  fs.writeFileSync(path.join(issues, '01-first.md'), '# 01: First\n\n**What to build:** first slice\n\n**Blocked by:** None\n\n- [ ] first passes\n');
  const handoff = '- `.scratch/feature/spec.md`\n- `.scratch/feature/issues/`';
  const delivery = completedResult(handoff, 'acp.sequential-delivery/v1');
  delivery.snapshot.artifacts['tasks.tickets'] = {
    name: 'tickets', type: 'acp.workspace-files/v1', format: 'markdown', value: handoff, producerNodeId: 'tasks',
  };
  const starts: string[] = [];
  const run = createWorkspaceRun({
    workspaceCwd: cwd,
    start: async pipelineName => {
      starts.push(pipelineName);
      if (pipelineName === 'delivery') return delivery;
      return completedResult(pipelineName === 'review-delivery' ? 'review complete' : 'ticket complete');
    },
    resume: async () => { throw new Error('not paused'); },
  });

  const final = await run.start('delivery', 'ship it');

  assert.equal(final.status, 'completed');
  assert.deepEqual(starts, ['delivery', 'implement-ticket', 'review-delivery']);
});

test('synthesizeTicketGraphArtifact reconstructs an acp.ticket-graph/v1 artifact from a workspace-files handoff', () => {
  const cwd = workspace();
  const issuesDir = path.join(cwd, '.scratch', 'feature', 'issues');
  fs.mkdirSync(issuesDir, { recursive: true });
  fs.writeFileSync(path.join(cwd, '.scratch', 'feature', 'spec.md'), '# Spec\n');
  fs.writeFileSync(path.join(issuesDir, '01-first.md'), [
    '# 01: First',
    '',
    '**What to build:** first slice',
    '',
    '**Blocked by:** None (can start immediately)',
    '',
    '**Status:** ready-for-agent',
    '',
    '- [ ] first passes',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(issuesDir, '02-second.md'), [
    '# 02: Second',
    '',
    '**What to build:** second slice',
    '',
    '**Blocked by:** 01: First',
    '',
    '**Status:** ready-for-agent',
    '',
    '- [ ] second passes',
    '',
  ].join('\n'));
  const handoff: PipelineArtifact = {
    name: 'tickets',
    type: 'acp.workspace-files/v1',
    format: 'markdown',
    value: '- `.scratch/feature/spec.md`\n- `.scratch/feature/issues/`',
    producerNodeId: 'tasks',
  };

  const graph = synthesizeTicketGraphArtifact(cwd, handoff);

  assert.equal(graph?.type, 'acp.ticket-graph/v1');
  assert.equal(graph?.format, 'json');
  assert.equal(graph?.producerNodeId, 'tasks');
  const value = graph?.value as { contract: string; tickets: Array<{ id: string; needs: string[] }> };
  assert.equal(value.contract, 'acp.ticket-graph/v1');
  assert.deepEqual(value.tickets.map(t => t.id), ['01', '02']);
  assert.deepEqual(value.tickets.find(t => t.id === '02')?.needs, ['01']);
});

test('synthesizeTicketGraphArtifact returns null for non-workspace-files artifacts', () => {
  const cwd = workspace();
  const graph = synthesizeTicketGraphArtifact(cwd, {
    name: 'plan', type: 'acp.grill-decision/v1', format: 'markdown', value: 'plan', producerNodeId: 'plan',
  });
  assert.equal(graph, null);
});

test('synthesizeTicketGraphArtifact defers when the issues directory is not promoted yet', () => {
  const cwd = workspace();
  const graph = synthesizeTicketGraphArtifact(cwd, {
    name: 'tickets',
    type: 'acp.workspace-files/v1',
    format: 'markdown',
    value: '- `.scratch/not-promoted/spec.md`\n- `.scratch/not-promoted/issues/`',
    producerNodeId: 'tasks',
  });

  assert.equal(graph, null);
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

test('WorkspaceRun ignores its persisted run state for documentation-only pauses', async () => {
  const cwd = workspace();
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  fs.writeFileSync(path.join(cwd, 'README.md'), '# Workspace\n');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', [
    '-c', 'user.name=ACP Test', '-c', 'user.email=acp@example.test',
    'commit', '-m', 'initial',
  ], { cwd, stdio: 'ignore' });
  const run = createWorkspaceRun({
    workspaceCwd: cwd,
    start: async () => {
      const runDirectory = path.join(cwd, '.acp', 'runs-v3', 'workspace', 'runs', 'run-plan');
      fs.mkdirSync(runDirectory, { recursive: true });
      fs.writeFileSync(path.join(runDirectory, 'events.ndjson'), '{}\n');
      fs.writeFileSync(path.join(runDirectory, 'snapshot.json'), '{}\n');
      return {
        status: 'paused', runId: 'run-plan',
        pause: {
          id: 'approval', nodeId: 'plan_approval', type: 'approval',
          content: 'Approve this plan?', format: 'proposed-plan',
          workspaceGuard: 'documentation-only',
        },
        snapshot: runtimeSnapshot('paused'),
      };
    },
    resume: async () => { throw new Error('not resumed'); },
  });

  const outcome = await run.start('planning', 'make a plan');

  assert.equal(outcome.status, 'interaction-required');
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

function completedDeliveryResult(value: string, ticketGraph: unknown): PipelineRuntimeResult {
  const result = completedResult(value, 'acp.sequential-delivery/v1');
  result.snapshot.artifacts['tasks.ticketGraph'] = {
    name: 'ticketGraph', type: 'acp.ticket-graph/v1', format: 'json', value: ticketGraph, producerNodeId: 'tasks',
  };
  return result;
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
  if (request.args.join(' ') === 'ls --json') return { exitCode: 0, stdout: '[]\n', stderr: '' };
  return { exitCode: 0, stdout: '', stderr: '' };
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

for (const change of ['unchanged', 'modified', 'restored', 'deleted', 'untracked'] as const) {
  test(`WorkspaceRun reports only changes since its baseline: ${change}`, async t => {
    const cwd = workspace();
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    git('init');
    for (const file of ['preexisting.txt', 'target.txt']) fs.writeFileSync(path.join(cwd, file), 'original\n');
    git('add', '.');
    git('-c', 'user.name=ACP Test', '-c', 'user.email=acp@example.test', 'commit', '-m', 'initial');
    fs.writeFileSync(path.join(cwd, 'preexisting.txt'), 'already dirty\n');
    fs.writeFileSync(path.join(cwd, 'target.txt'), 'already dirty\n');
    const run = createWorkspaceRun({
      workspaceCwd: cwd,
      start: async () => {
        if (change === 'modified') fs.writeFileSync(path.join(cwd, 'target.txt'), 'changed during run\n');
        if (change === 'restored') fs.writeFileSync(path.join(cwd, 'target.txt'), 'original\n');
        if (change === 'deleted') fs.unlinkSync(path.join(cwd, 'target.txt'));
        if (change === 'untracked') fs.writeFileSync(path.join(cwd, 'new.txt'), 'new\n');
        return {
          status: 'paused', runId: 'run-plan',
          pause: {
            id: 'approval', nodeId: 'plan_approval', type: 'approval',
            content: 'Approve?', format: 'markdown', workspaceGuard: 'documentation-only',
          },
          snapshot: runtimeSnapshot('paused'),
        };
      },
      resume: async () => { throw new Error('not resumed'); },
    });
    const outcome = await run.start('planning', 'make a plan');
    if (change === 'unchanged') {
      assert.equal(outcome.status, 'interaction-required');
      return;
    }
    assert.equal(outcome.status, 'failed');
    if (outcome.status !== 'failed') return;
    assert.equal(outcome.error.code, 'preimplementation_workspace_change');
    assert.doesNotMatch(outcome.error.message, /preexisting\.txt/);
    assert.match(outcome.error.message, /since the run started/);
    assert.match(outcome.error.message, /Existing uncommitted changes.*not listed/);
    assert.match(outcome.error.message, change === 'untracked' ? /new\.txt/ : /target\.txt/);
    if (change === 'untracked') assert.doesNotMatch(outcome.error.message, /target\.txt/);
  });
}
