import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import test from 'node:test';

test('published package contains init, Pi, and Codex assets but no historical Vibe assets', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const result = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' }))[0];
  const files: string[] = result.files.map((entry: { path: string }) => entry.path);
  for (const expected of ['init/manifest.json', 'plugin/pi/manifest.json', 'plugin/codex/manifest.json', 'plugin/pi/skills/slopify-launch/GUIDE.md']) assert.ok(files.includes(expected), expected);
  assert.ok(files.every(file => !file.startsWith('plugin/vibe/')));
});
