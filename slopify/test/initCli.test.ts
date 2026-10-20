import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { SubprocessExecutor, SubprocessRequest } from '@acp-client/sandbox';
import { runInitCli } from '../src/initCli.js';

const packageRoot = path.resolve(import.meta.dirname, '../..');
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const sink = () => { const out: string[] = []; const err: string[] = []; return { out, err, write: (v: string) => { out.push(v); }, writeError: (v: string) => { err.push(v); }, select: async (_title: string, _options: string[]): Promise<string | undefined> => undefined }; };

test('noninteractive init installs assets and invokes the project-scoped skills pull exactly', async t => {
  const target = await mkdtemp(path.join(tmpdir(), 'slopify-cli-')); t.after(() => rm(target, { recursive: true, force: true }));
  let request: SubprocessRequest | undefined;
  const execute: SubprocessExecutor = async value => { request = value; value.onOutput?.('stdout', 'noisy'); return { exitCode: 0, stdout: 'noisy', stderr: '' }; };
  const output = sink();
  assert.equal(await runInitCli(['--cwd', target, '--host', 'all', '--yes', '--json'], output, process.cwd(), { packageRoot, execute, interactive: false }), 0);
  assert.deepEqual({ command: request?.command, args: request?.args, cwd: request?.cwd, stdin: request?.stdin }, {
    command: 'npx', args: ['--yes', 'skills@latest', 'add', 'mattpocock/skills', '--agent', 'universal', '--skill', '*', '--copy', '--yes'], cwd: target, stdin: 'ignore',
  });
  assert.ok(!request?.args.includes('--global'));
  assert.notEqual(request?.command, 'sbx');
  assert.equal(output.out.length, 1);
  assert.equal(JSON.parse(output.out[0]).result, 'succeeded');
  assert.deepEqual(output.err, ['noisy']);
});

test('omitted host prompts interactively, while --yes defaults to every manifest host', async t => {
  const cases: Array<[string[], string | undefined, string]> = [
    [[], 'pi', '.pi/skills/slopify-launch/SKILL.md'],
    [['--yes'], undefined, '.agents/skills/slopify-launch/SKILL.md'],
  ];
  for (const [args, selected, expected] of cases) {
    const target = await mkdtemp(path.join(tmpdir(), 'slopify-cli-')); t.after(() => rm(target, { recursive: true, force: true }));
    const output = sink(); let choices: string[] = [];
    output.select = async (_title, options) => { choices = options; return selected; };
    const effectiveArgs = ['--cwd', target, ...args];
    assert.equal(await runInitCli(effectiveArgs, output, process.cwd(), { packageRoot, execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }), interactive: true }), 0);
    assert.match(output.out[0], new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    if (!args.includes('--yes')) assert.deepEqual(choices, ['codex', 'pi', 'all']);
  }
});

test('interactive host selection still pulls skills automatically in project scope', async t => {
  const target = await mkdtemp(path.join(tmpdir(), 'slopify-cli-')); t.after(() => rm(target, { recursive: true, force: true }));
  const output = sink(); output.select = async () => 'pi';
  let request: SubprocessRequest | undefined;
  const execute: SubprocessExecutor = async value => { request = value; return { exitCode: 0, stdout: '', stderr: '' }; };

  assert.equal(await runInitCli(['--cwd', target], output, process.cwd(), { packageRoot, execute, interactive: true }), 0);
  assert.deepEqual({ command: request?.command, args: request?.args, cwd: request?.cwd, stdin: request?.stdin }, {
    command: 'npx', args: ['--yes', 'skills@latest', 'add', 'mattpocock/skills', '--agent', 'universal', '--skill', '*', '--copy', '--yes'], cwd: target, stdin: 'ignore',
  });
});

test('text and JSON usage errors are reported through their documented channels', async () => {
  const text = sink();
  assert.equal(await runInitCli(['--wat'], text, '/repo', { packageRoot, interactive: false }), 1);
  assert.deepEqual(text.out, []); assert.match(text.err[0], /Unknown init option/);
  const json = sink();
  assert.equal(await runInitCli(['--json'], json, '/repo', { packageRoot, interactive: true }), 1);
  assert.equal(JSON.parse(json.out[0]).result, 'invalid'); assert.deepEqual(json.err, []);
});

test('a nonzero skills result is a warning on text success', async t => {
  const target = await mkdtemp(path.join(tmpdir(), 'slopify-cli-')); t.after(() => rm(target, { recursive: true, force: true }));
  const output = sink();
  assert.equal(await runInitCli(['--cwd', target, '--host', 'pi', '--yes'], output, process.cwd(), {
    packageRoot, execute: async () => ({ exitCode: 9, stdout: '', stderr: 'network unavailable' }), interactive: false,
  }), 0);
  assert.match(output.out[0], /Warnings.*exit code 9.*network unavailable/s);
});

test('a thrown skills executor error is a warning and JSON never prompts', async t => {
  const target = await mkdtemp(path.join(tmpdir(), 'slopify-cli-')); t.after(() => rm(target, { recursive: true, force: true }));
  const output = sink(); let selected = false; output.select = async () => { selected = true; return 'pi'; };
  assert.equal(await runInitCli(['--cwd', target, '--host', 'codex', '--json'], output, process.cwd(), {
    packageRoot, execute: async () => { throw new Error('offline'); }, interactive: true,
  }), 0);
  assert.equal(selected, false);
  assert.match(JSON.parse(output.out[0]).warnings[0], /offline/);
});

test('Pi-only init rejects external-installer symlinks before files or subprocesses can mutate anything', async t => {
  for (const route of ['.agents', '.agents/skills', 'skills-lock.json']) {
    const target = await mkdtemp(path.join(tmpdir(), 'slopify-cli-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'slopify-outside-'));
    t.after(() => Promise.all([rm(target, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
    const sentinel = path.join(outside, 'sentinel.txt'); await writeFile(sentinel, 'outside unchanged');
    if (route === '.agents/skills') await mkdir(path.join(target, '.agents'));
    const linkTarget = route === 'skills-lock.json' ? path.join(outside, 'skills-lock.json') : outside;
    if (route === 'skills-lock.json') await writeFile(linkTarget, 'lock unchanged');
    await symlink(linkTarget, path.join(target, route));
    let executions = 0;

    const output = sink();
    assert.equal(await runInitCli(['--cwd', target, '--host', 'pi', '--yes'], output, process.cwd(), {
      packageRoot, execute: async () => { executions += 1; return { exitCode: 0, stdout: '', stderr: '' }; }, interactive: false,
    }), 1);
    assert.match(output.err[0], /symlinked init destination/);
    assert.equal(executions, 0);
    assert.equal(await readFile(sentinel, 'utf8'), 'outside unchanged');
    if (route === 'skills-lock.json') assert.equal(await readFile(linkTarget, 'utf8'), 'lock unchanged');
    await assert.rejects(access(path.join(target, '.pi')), /ENOENT/);
    await assert.rejects(access(path.join(target, '.scratch')), /ENOENT/);
  }
});

test('general and init help expose the V2 initialization command', () => {
  for (const args of [['--help'], ['init', '--help']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /slopify init.*--host <pi\|codex\|all>/s);
  }
});
