import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('general and init help expose the V2 initialization command', () => {
  for (const args of [['--help'], ['init', '--help']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /slopify init.*--host <pi\|codex\|all>/s);
  }
});

test('a symlinked V2 CLI finds init and Pi/Codex assets from the package that owns them', { skip: process.platform === 'win32' }, async t => {
  const { mkdtemp, mkdir, chmod, writeFile, symlink, readFile, rm } = await import('node:fs/promises');
  const path = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-v2-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const project = path.join(root, 'project');
  await Promise.all([mkdir(bin), mkdir(project)]);
  const linkedCli = path.join(bin, 'slopify');
  await symlink(cli, linkedCli);
  // init pulls external skills via npx; keep this contract test strictly offline.
  const fakeNpx = path.join(bin, 'npx');
  await writeFile(fakeNpx, '#!/bin/sh\\nexit 0\\n');
  await chmod(fakeNpx, 0o755);
  const result = spawnSync(process.execPath, [linkedCli, 'init', '--cwd', project, '--host', 'all', '--yes', '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).result, 'succeeded');
  for (const relative of ['.scratch/slopify/spec.md', '.pi/skills/slopify-launch/SKILL.md', '.agents/skills/slopify-launch/SKILL.md']) {
    assert.ok((await readFile(path.join(project, relative), 'utf8')).length > 0, relative);
  }
});
