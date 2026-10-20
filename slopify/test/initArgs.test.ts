import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInitArgs } from '../src/initArgs.js';

test('parses every init option and resolves the target directory', () => {
  assert.deepEqual(parseInitArgs(['--cwd', 'demo', '--host', 'pi', '--yes', '--json', '--verbose'], '/repo'), {
    cwd: '/repo/demo', host: 'pi', yes: true, json: true, verbose: true, help: false,
  });
});

test('rejects unknown options, positionals, and missing values while leaving manifest hosts to the service', () => {
  assert.equal(parseInitArgs(['--host', 'future-host']).host, 'future-host');
  assert.throws(() => parseInitArgs(['--wat']), /Unknown init option/);
  assert.throws(() => parseInitArgs(['extra']), /does not accept positional/);
  assert.throws(() => parseInitArgs(['--cwd']), /--cwd requires/);
  assert.throws(() => parseInitArgs(['--host']), /--host requires/);
});
