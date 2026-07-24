import assert from 'node:assert/strict';
import test from 'node:test';

import { AcpRunner } from '../src/acp/acpRunner.js';

test('AcpRunner executes an already-resolved request without workspace discovery', async () => {
  let receivedProcessConfig: unknown;
  let disposed = false;
  const runner = new AcpRunner();
  const result = await runner.run({
    agentName: 'Resolved agent',
    sessionCwd: '/virtual/session',
    processConfig: { command: 'resolved-command', args: ['acp'] },
    prompt: [{ type: 'text', text: 'resolved prompt' }],
    connector: async input => {
      receivedProcessConfig = input.processConfig;
      return {
        agentId: 'agent-1',
        connInfo: {
          initResponse: {},
          client: undefined,
          connection: {
            newSession: async () => ({ sessionId: 'session-1' }),
            prompt: async () => {
              input.sessionUpdateHandler.handleUpdate({
                sessionId: 'session-1',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'done' },
                },
              });
              return { stopReason: 'end_turn' };
            },
            cancel: async () => undefined,
            authenticate: async () => ({}),
          },
        } as never,
        dispose: () => { disposed = true; },
      };
    },
    finalize: async ({ sessionId }) => `finalized:${sessionId}`,
  });

  assert.deepEqual(receivedProcessConfig, { command: 'resolved-command', args: ['acp'] });
  assert.deepEqual(result, { text: 'done', finalization: 'finalized:session-1' });
  assert.equal(disposed, true);
});
