import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROTOCOL_VERSION,
  type Agent,
  type AgentSideConnection,
  type InitializeRequest,
  type NewSessionRequest,
  type PromptRequest,
} from '@agentclientprotocol/sdk';

import { AcpRunner, createInMemoryAcpConnector } from '../src/index.js';

class EmbeddedAgent implements Agent {
  constructor(private readonly connection: AgentSideConnection) {}

  async initialize(_params: InitializeRequest) {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
  }

  async authenticate() { return {}; }
  async newSession(_params: NewSessionRequest) { return { sessionId: 'embedded-session' }; }

  async prompt(params: PromptRequest) {
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'embedded output' },
      },
    });
    return { stopReason: 'end_turn' as const };
  }

  async cancel() {}
  async extMethod(method: string) { return { method, active: true }; }
}

test('runs an embedded agent and extension through a real ACP connection', async () => {
  const result = await new AcpRunner().run({
    agentName: 'Embedded',
    sessionCwd: process.cwd(),
    processConfig: { command: process.execPath },
    prompt: [{ type: 'text', text: 'hello' }],
    connector: createInMemoryAcpConnector(connection => new EmbeddedAgent(connection)),
    finalize: async ({ connected, sessionId }) => connected.connInfo.connection.extMethod(
      'sandbox/status',
      { sessionId },
    ),
  });

  assert.equal(result.text, 'embedded output');
  assert.deepEqual(result.finalization, { method: 'sandbox/status', active: true });
});
