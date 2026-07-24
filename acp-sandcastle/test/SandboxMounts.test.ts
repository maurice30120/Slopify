import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { buildSandboxMounts, createDockerSandboxProvider, prepareCodexHome } from '../src/SandboxMounts.js';

test('prepareCodexHome creates a writable sandbox-local directory', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sandcastle-codex-home-'));
  try {
    const codexHome = prepareCodexHome(repo);
    assert.equal(codexHome, path.join(repo, '.sandcastle', 'codex-home'));
    assert.ok(fs.existsSync(codexHome));
    fs.writeFileSync(path.join(codexHome, 'runtime.txt'), 'ok', 'utf8');
    assert.equal(fs.readFileSync(path.join(codexHome, 'runtime.txt'), 'utf8'), 'ok');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('buildSandboxMounts includes skills and provider auth mounts', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sandcastle-mounts-'));
  try {
    fs.mkdirSync(path.join(repo, '.agents', 'skills'), { recursive: true });

    const codexMounts = buildSandboxMounts({ provider: 'codex' }, repo);
    const vibeMounts = buildSandboxMounts({ provider: 'vibe' }, repo);

    assert.ok(codexMounts.some(mount => mount.sandboxPath === '.agents'));
    assert.ok(codexMounts.some(mount => mount.sandboxPath === '/home/agent/.codex'));
    assert.ok(vibeMounts.some(mount => mount.sandboxPath === '.agents'));
    assert.ok(vibeMounts.some(mount => mount.sandboxPath === '/home/agent/.vibe'));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('buildSandboxMounts adds git overrides for docker worktrees', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sandcastle-git-mounts-'));
  try {
    git(repo, ['init']);
    const cwd = path.join(repo, 'plugin');
    fs.mkdirSync(cwd);
    const branch = 'sandcastle/acp/vibe/123';
    const mounts = buildSandboxMounts({ provider: 'vibe' }, cwd, branch);

    const parentGitMount = mounts.find(mount => mount.sandboxPath === '/.sandcastle-parent-git');
    assert.ok(parentGitMount);
    assert.equal(parentGitMount.readonly, false);
    assert.equal(fs.statSync(parentGitMount.hostPath).isDirectory(), true);
    assert.equal(gitWithDir(parentGitMount.hostPath, ['rev-parse', '--is-bare-repository']), 'false');

    const gitOverride = mounts.find(mount => mount.sandboxPath === '/home/agent/workspace/.git');
    assert.ok(gitOverride);
    assert.equal(gitOverride.readonly, true);
    assert.equal(
      fs.readFileSync(gitOverride.hostPath, 'utf8'),
      'gitdir: /.sandcastle-parent-git/worktrees/sandcastle-acp-vibe-123\n',
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('createDockerSandboxProvider builds docker sandbox config with shared mounts', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sandcastle-docker-provider-'));
  try {
    const provider = createDockerSandboxProvider({
      provider: 'vibe',
      imageName: 'test:image',
      cpus: 3,
    }, repo) as any;

    assert.equal(provider.tag, 'bind-mount');
    assert.equal(provider.name, 'docker');
    assert.equal(typeof provider.create, 'function');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function gitWithDir(gitDir: string, args: string[]): string {
  return execFileSync('git', [`--git-dir=${gitDir}`, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}
