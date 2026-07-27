import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  type Agent,
  type Stream,
} from '@agentclientprotocol/sdk';
import { AcpClient } from './acpClient.js';
import type { AcpConnector, AcpConnectorInput } from './defaultConnector.js';
import { FileSystemHandler } from './fileSystemHandler.js';
import { resolveTimeouts, withTimeout } from './operationGuards.js';
import { PermissionHandler } from './permissionHandler.js';
import { TerminalHandler } from './terminalHandler.js';

export type InMemoryAcpAgentFactory = (
  connection: AgentSideConnection,
  input: AcpConnectorInput,
) => Agent;

/** Connects an embedded bridge through the real ACP JSON-RPC protocol. */
export function createInMemoryAcpConnector(factory: InMemoryAcpAgentFactory): AcpConnector {
  return async input => {
    const clientToAgent = new TransformStream<any, any>();
    const agentToClient = new TransformStream<any, any>();
    const agentStream: Stream = {
      writable: agentToClient.writable,
      readable: clientToAgent.readable,
    };
    const clientStream: Stream = {
      writable: clientToAgent.writable,
      readable: agentToClient.readable,
    };

    const agentConnection = new AgentSideConnection(
      connection => factory(connection, input),
      agentStream,
    );
    let client: AcpClient | null = null;
    const connection = new ClientSideConnection((_agent: Agent) => {
      client = new AcpClient(
        new FileSystemHandler(input.workspaceCwd),
        new TerminalHandler(input.workspaceCwd),
        new PermissionHandler(input.getPermissionContext, {
          autoApproveAll: input.autoApprovePermissions,
          timeoutMs: resolveTimeouts(input.timeouts).permissionMs,
        }),
        input.sessionUpdateHandler,
      );
      return client;
    }, clientStream);

    const initResponse = await withTimeout(
      'initialize',
      resolveTimeouts(input.timeouts).initializeMs,
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'acp-runtime', version: '0.0.0' },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      }),
    );
    if (!client) throw new Error('In-memory ACP client was not initialized.');

    let disposed = false;
    return {
      agentId: `embedded:${input.agentName}`,
      connInfo: { connection, client, initResponse },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        client?.dispose();
        void agentConnection.signal;
      },
    };
  };
}
