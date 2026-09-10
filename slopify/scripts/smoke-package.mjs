import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slopify-package-'));
const cliRoot = fileURLToPath(new URL('../', import.meta.url));
try {
  const cache = path.join(root, 'cache');
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root, '--cache', cache], {
    cwd: cliRoot, encoding: 'utf8',
  }));
  const packageInfo = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  execFileSync('npm', ['install', '--prefix', path.join(root, 'installed'), '--offline', '--ignore-scripts',
    '--cache', cache, path.join(root, packageInfo.filename)], { stdio: 'pipe' });
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const executable = path.join(root, 'installed/node_modules/slopify/dist/bin/cli.js');
  const result = JSON.parse(execFileSync(process.execPath, [executable, 'list', '--cwd', project, '--json'], {
    cwd: project, encoding: 'utf8',
  }));
  assert.deepEqual(result.map(program => program.id), [
    'grill-spec-tickets-implement-review', 'implement-ticket', 'review-delivery',
  ]);
  assert.ok(fs.existsSync(path.join(root, 'installed/node_modules/slopify/dist/resources/.agents/skills/domain-modeling/CONTEXT-FORMAT.md')));
  const vibeKitSpec = path.join(root, 'installed/node_modules/slopify/dist/resources/.sbx/vibe/spec.yaml');
  assert.ok(fs.existsSync(vibeKitSpec));
  assert.match(fs.readFileSync(vibeKitSpec, 'utf8'), /name: vibe/);
  for (const pipeline of ['grill-spec-tickets-implement-review', 'implement-ticket', 'review-delivery']) {
    const pipelinePath = path.join(root, 'installed/node_modules/slopify/dist/resources/.acp/pipelines', `${pipeline}.yaml`);
    assert.match(fs.readFileSync(pipelinePath, 'utf8'), /agent: Vibe Sandbox/);
    assert.doesNotMatch(fs.readFileSync(pipelinePath, 'utf8'), /agent: OpenCode Sandbox/);
  }
  assert.deepEqual(fs.readdirSync(project), []);
  const agentFile = path.join(root, 'agent.cjs');
  fs.writeFileSync(agentFile, String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const send = message => process.stdout.write(JSON.stringify({jsonrpc: '2.0', ...message}) + '\n');
readline.createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'initialize') result = {protocolVersion: request.params.protocolVersion, agentCapabilities: {}};
  if (request.method === 'session/new') result = {sessionId: 'smoke'};
  if (request.method === 'session/prompt') {
    const prompt = request.params.prompt.map(block => block.text ?? '').join('\n');
    const file = /\(path: (.*?\/slopify\/grilling\/SKILL.md)\)/.exec(prompt)?.[1];
    if (!file || !fs.readFileSync(file, 'utf8').includes('name: grilling')) {
      send({id: request.id, error: {code: -32603, message: 'Frozen skill unreadable'}});
      return;
    }
    send({method: 'session/update', params: {sessionId: 'smoke', update: {sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'Frozen skill read successfully.'}}}});
    result = {stopReason: 'end_turn'};
  }
  send({id: request.id, result});
});
`);
  fs.mkdirSync(path.join(project, '.acp/pipelines'), { recursive: true });
  fs.writeFileSync(path.join(project, '.acp/acp-agents.json'), JSON.stringify({
    agents: { Smoke: { command: process.execPath, args: [agentFile] } },
  }));
  fs.writeFileSync(path.join(project, '.acp/pipelines/smoke.yaml'), `version: 3
id: smoke
title: Smoke
nodes:
  - id: read
    agent: Smoke
    skills: [slopify:grilling]
    prompt: Read the skill.
    output: {name: result, type: text, format: text}
`);
  const run = JSON.parse(execFileSync(process.execPath, [executable, 'run', '--pipeline', 'smoke', '--cwd', project, '--json', 'Check resources'], {
    cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  assert.equal(run.status, 'completed');
  assert.match(JSON.stringify(run), /Frozen skill read successfully/);
  console.log('Packed CLI installed offline, listed bundled pipelines in an empty project, and completed an ACP run reading a bundled skill.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
