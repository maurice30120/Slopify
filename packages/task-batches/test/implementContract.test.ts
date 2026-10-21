import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import type { SubprocessExecutor } from '@slopify/execution';
import { TaskBatchService } from './taskBatchTestService.js';
import { git, prepareSlopifyFixture, fakeSbxExecutor } from './activityTickHarness.js';

const specification = '# Frozen specification\nUse the agreed public checkout interface.\n';
const ticket = 'Ticket preserved verbatim\nApproved seam: checkout(order).\nKeep accents: été.';

interface Observation {
  prompt: string;
  harness: string;
  spec: string;
  cwd: string;
  head: string;
  resources: Record<string, string>;
}

async function contractFixture(t: test.TestContext, mode: 'local' | 'sandbox', agent: 'pi' | 'codex', options: {
  review?: 'leading' | 'inline';
  firstSource?: string;
} = {}) {
  const invocation = agent === 'pi' ? '/skill:implement ' : '$implement\n';
  const reviewInvocation = agent === 'pi' ? '/skill:code-review ' : '$code-review\n';
  const tasks = [
    { id: 'first', agent, source: options.firstSource ?? 'first.md', dependsOn: [], prompt: ticket },
    { id: 'final-review', agent, source: 'second.md', dependsOn: ['first'], prompt: (options.review === 'inline' ? 'Apply ' : '') + (options.review ? reviewInvocation : invocation) + ticket },
  ];
  const f = await prepareSlopifyFixture('slopify-implement-contract-', t, tasks);
  await writeFile(path.join(f.root, 'spec.md'), specification);
  await writeFile(path.join(f.repo, 'base.txt'), 'dirty user content');
  await writeFile(path.join(f.repo, 'untracked.txt'), 'untouched');
  const dirty = git(f.repo, 'status', '--porcelain=v1');
  const home = path.join(f.root, 'home');
  const skills = path.join(home, '.agents', 'skills');
  const resources = {
    'implement/SKILL.md': '---\nname: implement\ndisable-model-invocation: true\n---\n[details](details.md)\nUse tdd and code-review.',
    'implement/details.md': 'Complete installed implement resource.',
    'tdd/SKILL.md': '---\nname: tdd\n---\n[tests](tests.md)',
    'tdd/tests.md': 'Complete installed TDD resource.',
    'code-review/SKILL.md': '---\nname: code-review\n---\n[baseline](baseline.md)',
    'code-review/baseline.md': 'Complete installed review resource.',
  };
  for (const [relative, content] of Object.entries(resources)) {
    await mkdir(path.dirname(path.join(skills, relative)), { recursive: true });
    await writeFile(path.join(skills, relative), content);
  }
  const observations = path.join(f.root, 'observations.jsonl');
  const bin = path.join(f.root, 'bin');
  await mkdir(bin);
  // This process replaces only the external agent. Production runners, verdict
  // handling, private clones, checkpoint creation and final review stay in use.
  const program = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const args = process.argv.slice(2);
const prompt = args.at(-1);
const pi = path.basename(process.argv[1]) === 'pi';
const harness = pi ? fs.readFileSync(args[args.indexOf('--append-system-prompt') + 1], 'utf8')
  : JSON.parse(args.find(a => a.startsWith('developer_instructions=')).slice('developer_instructions='.length));
const specPath = harness.match(/Read the full frozen spec: (.+)/)[1];
const root = args.includes('--skill') ? args[args.indexOf('--skill') + 1] : path.join(process.env.HOME, '.agents/skills');
const resources = Object.fromEntries(${JSON.stringify(Object.keys(resources))}.map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
const observation = {prompt, harness, spec: fs.readFileSync(specPath, 'utf8'), cwd: process.cwd(), head: execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim(), resources};
fs.appendFileSync(${JSON.stringify(observations)}, JSON.stringify(observation) + '\\n');
fs.writeFileSync('implemented.txt', 'installed skill contract');
const message = 'Observed fake agent result\\nSLOPIFY_RESULT={"status":"succeeded"}';
console.log(JSON.stringify(pi ? {type:'message_end', message:{role:'assistant',content:[{type:'text',text:message}]}} : {type:'item.completed', item:{type:'agent_message',text:message}}));
`;
  await Promise.all(['pi', 'codex'].map(name => writeFile(path.join(bin, name), program, { mode: 0o755 })));
  const previous = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.PATH = bin + path.delimiter + previous.PATH;
  process.env.HOME = home;
  t.after(() => { process.env.PATH = previous.PATH; process.env.HOME = previous.HOME; });
  const sandboxes = new Map<string, string>();
  const copied = new Map<string, string>();
  const reviewerRoles: string[] = [];
  const base = fakeSbxExecutor({ ...f, skills, sandboxes, agent: async () => 0 });
  const execute: SubprocessExecutor = async request => {
    const a = request.args;
    if (request.command !== 'sbx') return base(request);
    if (a[0] === 'cp' && !a.at(-1)?.endsWith('codex-sessions')) {
      copied.set(a[2].slice(a[2].indexOf(':') + 1), a[1]);
      if (a[1].includes(path.join('pi-config', 'agents'))) reviewerRoles.push(await readFile(a[1], 'utf8'));
    }
    if (a[0] === 'exec' && ((a.includes('pi') && a.includes('--print')) || (a.includes('codex') && a.includes('--json')))) {
      const agentIndex = a.indexOf(agent);
      const args = a.slice(agentIndex + 1).map(value => copied.get(value) ?? value);
      const name = a.find(value => sandboxes.has(value))!;
      const result = spawnSync(path.join(bin, agent), args, { cwd: sandboxes.get(name), encoding: 'utf8' });
      return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    }
    return base(request);
  };
  const service = new TaskBatchService({ repositoryPath: f.repo, storePath: path.join(f.root, 'runs'), subprocessExecutor: execute });
  const abort = new AbortController();
  const running = service.run(f.batchFile, { mode, signal: abort.signal });
  t.after(async () => { abort.abort(); await running.catch(() => undefined); });
  const state = await running;
  return { ...f, state, dirty, tasks, resources, skills, reviewerRoles,
    observed: (await readFile(observations, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Observation) };
}

for (const [mode, agent] of [['local', 'pi'], ['local', 'codex'], ['sandbox', 'pi'], ['sandbox', 'codex']] as const) {
test(`${agent} ${mode} receives the installed implement contract and retains the separate final batch review`, async t => {
  const f = await contractFixture(t, mode, agent);
  assert.equal(f.state.status, 'succeeded');
  const [first, second, review] = f.observed;
  assert.equal(f.observed.length, 3);
  assert.match(first.prompt, agent === 'pi' ? /^\/skill:implement / : /^\$implement\n/);
  assert.ok(first.prompt.endsWith(ticket));
  assert.equal(second.prompt, f.tasks[1].prompt, 'an existing native invocation stays intact');
  assert.match(review.prompt, agent === 'pi' ? /^\/skill:code-review / : /^\$code-review\n/);
  assert.doesNotMatch(review.prompt, /\/skill:implement|\$implement/);
  assert.deepEqual(first.resources, f.resources);
  for (const role of f.reviewerRoles) {
    assert.ok(role.includes(path.join(f.skills, 'code-review', 'SKILL.md')));
    assert.ok(!role.includes(f.resources['code-review/SKILL.md']), 'review roles point to the installed skill instead of copying it');
  }
  assert.equal(first.spec, specification);
  assert.match(first.harness, /checkout|interfaces.*approved/i);
  assert.doesNotMatch(first.harness, /reviews? (?:are )?not required|skip.{0,80}code-review|follow one red\/green/i);
  assert.ok(first.harness.includes(first.head));
  assert.ok(second.harness.includes(second.head));
  assert.ok(second.harness.includes(f.head), 'run baseline remains available after an integration');
  assert.notEqual(second.head, first.head, 'dependent ticket starts after integration');
  assert.equal(f.state.tasks.at(-1)!.id, 'final-review-2');
  assert.equal(f.state.tasks.at(-1)!.source, 'final-review');
  assert.equal(f.state.tasks.at(-1)!.status, 'succeeded');
  assert.deepEqual(f.state.tasks.slice(0, 2).map(task => task.prompt), f.tasks.map(task => task.prompt));
  assert.equal(git(f.repo, 'status', '--porcelain=v1'), f.dirty);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
  assert.equal(git(f.repo, 'show', `${f.state.integrationBranch}:implemented.txt`), 'installed skill contract');
  for (const task of f.state.tasks) {
    const attempt = task.attempts[0];
    assert.ok((await readFile(attempt.checkpoint!.bundlePath!)).length > 0);
    assert.match(await readFile(attempt.stdoutPath!, 'utf8'), /Observed fake agent result/);
    assert.match(await readFile(attempt.reportPath!, 'utf8'), /Observed fake agent result/);
  }
  for (const [file, content] of Object.entries(f.resources)) assert.equal(await readFile(path.join(f.skills, file), 'utf8'), content);
});
}

for (const agent of ['pi', 'codex'] as const) {
test(`an explicit native ${agent} review task keeps its requested workflow`, async t => {
  const f = await contractFixture(t, 'local', agent, { review: 'leading' });
  assert.equal(f.state.status, 'succeeded');
  assert.equal(f.observed[1].prompt, f.tasks[1].prompt);
});
}

test('a Codex review reference inside the prompt keeps its requested workflow', async t => {
  const f = await contractFixture(t, 'local', 'codex', { review: 'inline' });
  assert.equal(f.state.status, 'succeeded');
  assert.equal(f.observed[1].prompt, f.tasks[1].prompt);
});

test('a ticket source named final-review remains an implementation task', async t => {
  const f = await contractFixture(t, 'local', 'pi', { firstSource: 'final-review' });
  assert.equal(f.state.status, 'succeeded');
  assert.match(f.observed[0].prompt, /^\/skill:implement /);
  assert.ok(f.observed[0].prompt.endsWith(f.tasks[0].prompt));
  assert.equal(f.state.tasks[0].source, 'final-review');
  assert.match(f.observed.at(-1)!.prompt, /^\/skill:code-review /);
  assert.equal(f.state.tasks.at(-1)!.id, 'final-review-2');
});
