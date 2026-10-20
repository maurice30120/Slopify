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
