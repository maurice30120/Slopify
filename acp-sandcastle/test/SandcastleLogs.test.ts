import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { clearSandcastleLogs } from '../src/SandcastleLogs.js';

test('clearSandcastleLogs removes only Sandcastle diagnostic log directories', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sandcastle-logs-'));
  try {
    const logsDir = path.join(workspace, '.sandcastle', 'logs');
    const vibeSessionDir = path.join(workspace, '.sandcastle', 'vibe-home', 'logs', 'session');
    const vibeHomeDir = path.join(workspace, '.sandcastle', 'vibe-home');
    const worktreesDir = path.join(workspace, '.sandcastle', 'worktrees', 'active');
    const gitOverridesDir = path.join(workspace, '.sandcastle', 'git-overrides');
    const codexHomeDir = path.join(workspace, '.sandcastle', 'codex-home');

    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(vibeSessionDir, { recursive: true });
    fs.mkdirSync(worktreesDir, { recursive: true });
    fs.mkdirSync(gitOverridesDir, { recursive: true });
    fs.mkdirSync(codexHomeDir, { recursive: true });
    fs.writeFileSync(path.join(workspace, '.sandcastle', '.env'), 'TOKEN=kept\n');
    fs.writeFileSync(path.join(vibeHomeDir, 'config.toml'), 'kept = true\n');
    fs.writeFileSync(path.join(vibeHomeDir, '.env'), 'VIBE=kept\n');
    fs.writeFileSync(path.join(logsDir, 'stale.log'), 'stale\n');
    fs.writeFileSync(path.join(vibeSessionDir, 'messages.jsonl'), '{}\n');
    fs.writeFileSync(path.join(worktreesDir, 'file.txt'), 'kept\n');
    fs.writeFileSync(path.join(gitOverridesDir, 'override.git'), 'kept\n');
    fs.writeFileSync(path.join(codexHomeDir, 'config.toml'), 'kept\n');

    clearSandcastleLogs(workspace);

    assert.deepStrictEqual(fs.readdirSync(logsDir), []);
    assert.deepStrictEqual(fs.readdirSync(vibeSessionDir), []);
    assert.strictEqual(fs.readFileSync(path.join(workspace, '.sandcastle', '.env'), 'utf8'), 'TOKEN=kept\n');
    assert.strictEqual(fs.readFileSync(path.join(vibeHomeDir, 'config.toml'), 'utf8'), 'kept = true\n');
    assert.strictEqual(fs.readFileSync(path.join(vibeHomeDir, '.env'), 'utf8'), 'VIBE=kept\n');
    assert.strictEqual(fs.readFileSync(path.join(worktreesDir, 'file.txt'), 'utf8'), 'kept\n');
    assert.strictEqual(fs.readFileSync(path.join(gitOverridesDir, 'override.git'), 'utf8'), 'kept\n');
    assert.strictEqual(fs.readFileSync(path.join(codexHomeDir, 'config.toml'), 'utf8'), 'kept\n');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
