import assert from 'node:assert/strict';

import test from 'node:test';

import { PiRpcSession, type PiRpcChannelFactory } from '../src/piRpcSession.js';

/** Canal factice piloté par le test : vivant jusqu'à onExit, et journalise les commandes écrites. */
function fakeFactory(log: { writes: string[]; alive: boolean }, capture: { notifyExit?: (exit: { exitCode: number; stderrTail: string }) => void }): PiRpcChannelFactory {
  return session => {
    capture.notifyExit = session.onExit;
    return {
      writeLine: line => { log.writes.push(line); },
      close: async () => ({ exitCode: 0, stderrTail: '' }),
      get alive() { return log.alive; },
      describe: () => 'fake channel',
    };
  };
}

test('abort resolves immediately when the process death is observed, not after the 1s timeout', async () => {
  const log = { writes: [] as string[], alive: true };
  const capture: { notifyExit?: (exit: { exitCode: number; stderrTail: string }) => void } = {};
  const session = new PiRpcSession({ role: 'implementer', openChannel: fakeFactory(log, capture) });

  const started = Date.now();
  const pending = session.abort();
  assert.ok(capture.notifyExit, 'the channel received the exit callback');
  capture.notifyExit({ exitCode: 137, stderrTail: 'killed' });
  await pending;

  assert.ok(Date.now() - started < 500, `abort must resolve at once on observed death (took ${Date.now() - started}ms)`);
  assert.equal(log.writes.length, 1, 'the abort command was written while the channel was alive');
});

test('abort on a dead channel writes nothing and returns immediately', async () => {
  const log = { writes: [] as string[], alive: false };
  const capture: { notifyExit?: (exit: { exitCode: number; stderrTail: string }) => void } = {};
  const session = new PiRpcSession({ role: 'reviewer', openChannel: fakeFactory(log, capture) });

  const started = Date.now();
  await session.abort();

  assert.ok(Date.now() - started < 100, 'no wait on a dead channel');
  assert.equal(log.writes.length, 0, 'no abort command is written to a dead channel');
});
