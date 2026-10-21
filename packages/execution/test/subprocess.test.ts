import assert from 'node:assert/strict';
import test from 'node:test';
import { createNodeSubprocessExecutor } from '../src/index.js';

test('createNodeSubprocessExecutor preserves environment, streams output and exit code', async () => {
  const executor = createNodeSubprocessExecutor();
  const chunks: string[] = [];
  const result = await executor({
    command: process.execPath, args: ['-e', 'process.stdout.write("hello"); process.stderr.write("boom"); process.exit(3)'],
    cwd: process.cwd(), stdin: 'ignore', onOutput: (stream, chunk) => { if (stream === 'stdout') chunks.push(chunk); },
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, 'hello');
  assert.equal(result.stderr, 'boom');
  assert.deepEqual(chunks, ['hello']);
});

test('a missing command rejects and an aborted signal resolves with a nonzero exit', async () => {
  const executor = createNodeSubprocessExecutor();
  await assert.rejects(executor({ command: 'definitely-missing-slopify-binary', args: [], cwd: process.cwd(), stdin: 'ignore' }));
  const controller = new AbortController();
  controller.abort();
  const aborted = await executor({ command: process.execPath, args: ['-e', ''], cwd: process.cwd(), stdin: 'ignore', signal: controller.signal });
  assert.notEqual(aborted.exitCode, 0);
});
