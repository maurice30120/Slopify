import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import test from 'node:test';

interface PackedPackage {
  files: Array<{ path: string }>;
}

function isPackedPackage(value: unknown): value is PackedPackage {
  return value !== null && typeof value === 'object'
    && 'files' in value && Array.isArray(value.files)
    && value.files.every(file => file !== null && typeof file === 'object' && 'path' in file && typeof file.path === 'string');
}

test('published package contains init, Pi, and Codex assets but no historical Vibe assets', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' })) as unknown;
  const packages = Array.isArray(packed)
    ? packed
    : isPackedPackage(packed)
      ? [packed]
      : packed && typeof packed === 'object'
        ? Object.values(packed)
        : [];
  const result = packages.find(isPackedPackage);
  assert.ok(result, 'npm pack returned package files in an unsupported format');
  const files = result.files.map(entry => entry.path);
  for (const expected of ['init/manifest.json', 'plugin/pi/manifest.json', 'plugin/codex/manifest.json', 'plugin/pi/skills/slopify-launch/GUIDE.md']) assert.ok(files.includes(expected), expected);
  assert.ok(files.every(file => !file.startsWith('plugin/vibe/')));
});
