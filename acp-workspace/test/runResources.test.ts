import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { createInMemoryAcpConnector } from '@acp-client/runtime';
import { createWorkspaceRuntime } from '../src/index.js';

function write(root: string, name: string, content: string) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function skill(root: string, name: string, description: string, body: string, explicitOnly = false) {
  write(root, `.agents/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\ndisable-model-invocation: ${explicitOnly}\n---\n${body}`);
}

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-resources-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  const bundle = path.join(root, 'bundle');
  fs.mkdirSync(cwd);
  execFileSync('git', ['init', '-q'], { cwd });
  write(bundle, '.acp/acp-agents.json', JSON.stringify({ agents: { Agent: { command: 'unused' } } }));
  write(bundle, '.acp/pipelines/review.yaml', `version: 3
id: review
title: Review
nodes:
  - id: review
    agent: Agent
    skills: [slopify:review]
    prompt: Review it.
    output: {name: report, type: text, format: text}
`);
  write(bundle, 'manifest.json', JSON.stringify({ skills: {
    review: { dependencies: ['helper'], requiredProjectFiles: ['docs/agents/issue-tracker.md'] },
    helper: { dependencies: [] },
  } }));
  skill(bundle, 'review', 'Bundled review method', 'BUNDLED BODY', true);
  skill(bundle, 'helper', 'Supporting method', 'HELPER BODY', true);
  write(bundle, '.agents/skills/review/references/example.txt', 'FROZEN REFERENCE');
  skill(cwd, 'review', 'Project review method', 'PROJECT BODY');
  return { cwd, bundle };
}

const host = { permissionContext: () => undefined, logger: { log() {}, error() {} } };

test('ACP sends descriptions and readable frozen paths without inlining skill bodies or shadowing origins', async t => {
  const { cwd, bundle } = fixture(t);
  write(cwd, 'docs/agents/issue-tracker.md', 'Use local tickets.');
  const reads: string[] = [];
  let prompt = '';
  const runtime = createWorkspaceRuntime({
    workspaceCwd: cwd, embeddedRoot: bundle, host,
    resourcesStateRoot: path.join(path.dirname(cwd), 'external-state'),
    connectorOverrides: { native: createInMemoryAcpConnector(connection => ({
      async initialize() { return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }; },
      async authenticate() { return {}; },
      async newSession() { return { sessionId: 'session' }; },
      async cancel() {},
      async prompt(params) {
        prompt = params.prompt.map(block => block.type === 'text' ? block.text : '').join('\n');
        const file = /slopify:review: .*?\(path: (.*?)\)/.exec(prompt)?.[1];
        assert.ok(file);
        assert.ok(path.isAbsolute(file));
        reads.push((await connection.readTextFile({ sessionId: params.sessionId, path: file })).content);
        reads.push((await connection.readTextFile({ sessionId: params.sessionId, path: path.join(path.dirname(file), 'references/example.txt') })).content);
        await assert.rejects(connection.writeTextFile({ sessionId: params.sessionId, path: file, content: 'changed' }));
        return { stopReason: 'end_turn' };
      },
    })) },
  });
  const program = runtime.programs[0];
  await runtime.preflightPipeline(program, 'run-1');
  skill(bundle, 'review', 'UPDATED DESCRIPTION', 'UPDATED BODY');
  write(bundle, '.agents/skills/review/references/example.txt', 'UPDATED REFERENCE');
  await runtime.runAgent({ workspaceCwd: cwd, agentName: 'Agent', runId: 'run-1', promptText: 'Review', skills: ['slopify:review'] });
  assert.match(prompt, /Read each required SKILL.md before acting/);
  assert.match(prompt, /slopify:review: Bundled review method/);
  assert.match(prompt, /slopify:helper: Supporting method/);
  assert.match(prompt, /project:review: Project review method/);
  assert.doesNotMatch(prompt, /BUNDLED BODY|UPDATED|PROJECT BODY|HELPER BODY/);
  assert.match(reads[0], /BUNDLED BODY/);
  assert.equal(reads[1], 'FROZEN REFERENCE');
  assert.doesNotMatch(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' }), /slopify\/resources/);
});

test('preflight rejects missing prerequisites and missing skills before connecting an agent', async t => {
  const { cwd, bundle } = fixture(t);
  const runtime = createWorkspaceRuntime({ workspaceCwd: cwd, embeddedRoot: bundle, host });
  const program = runtime.programs[0];
  await assert.rejects(runtime.preflightPipeline(program, 'missing-config'), /requires project configuration docs\/agents\/issue-tracker.md/);
  write(cwd, 'docs/agents/issue-tracker.md', 'Local workflow');
  const node = { ...program.nodes[0], skills: ['slopify:unknown'] };
  await assert.rejects(runtime.preflightPipeline({ ...program, nodes: [node] }, 'missing-skill'), /skill "slopify:unknown" is missing/);
  const local = { ...program.nodes[0], skills: ['review'] };
  await runtime.preflightPipeline({ ...program, nodes: [local] }, 'local-skill');
});

test('resuming restores the original pipeline and detects missing or modified frozen files', async t => {
  const { cwd, bundle } = fixture(t);
  write(cwd, 'docs/agents/issue-tracker.md', 'Local workflow');
  const stateRoot = path.join(cwd, '.git/resources-test');
  const options = { workspaceCwd: cwd, embeddedRoot: bundle, resourcesStateRoot: stateRoot, host };
  const runtime = createWorkspaceRuntime(options);
  await runtime.preflightPipeline(runtime.programs[0], 'resume-run');
  fs.rmSync(path.join(bundle, '.acp/pipelines/review.yaml'));
  fs.rmSync(path.join(bundle, '.agents'), { recursive: true });
  const restored = createWorkspaceRuntime(options).restoreProgram('resume-run');
  assert.equal(restored.id, 'review');
  assert.deepEqual(restored.nodesById.get('review')?.skills, ['slopify:review']);
  assert.equal(restored.nodes[0].prompt, 'Review it.');
  const runRoot = path.join(stateRoot, fs.readdirSync(stateRoot)[0]);
  write(runRoot, 'slopify/review/SKILL.md', 'tampered');
  assert.throws(() => createWorkspaceRuntime(options).restoreProgram('resume-run'), /Frozen run resource changed or missing/);
  assert.throws(() => runtime.restoreProgram('unknown'), /Frozen run resources missing/);
});
