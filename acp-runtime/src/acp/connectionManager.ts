import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type InitializeResponse,
} from '@agentclientprotocol/sdk';
import type { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

import type { AgentProcessExit } from './agentProcess.js';
import { FileSystemHandler } from './fileSystemHandler.js';
import {
  resolveTimeouts,
  withProcessGuard,
  withTimeout,
  type PartialAcpOperationTimeouts,
} from './operationGuards.js';
import { PermissionHandler } from './permissionHandler.js';
import { AcpClient } from './acpClient.js';
import { SessionUpdateHandler } from './sessionUpdateHandler.js';
import { TerminalHandler } from './terminalHandler.js';
import type { Logger, RuntimePermissionContext } from '../types.js';

export interface ConnectionInfo {
  connection: ClientSideConnection;
  client: AcpClient;
  initResponse: InitializeResponse;
}

export interface ConnectionManagerOptions {
  logger?: Logger;
  getPermissionContext: () => RuntimePermissionContext | undefined;
  autoApprovePermissions?: boolean;
  timeouts?: PartialAcpOperationTimeouts;
}

export class ConnectionManager {
  private readonly connections = new Map<string, ConnectionInfo>();

  constructor(
    private readonly sessionUpdateHandler: SessionUpdateHandler,
    private readonly options: ConnectionManagerOptions,
  ) {}

  async connect(
    agentId: string,
    process: ChildProcess,
    workspaceCwd: string,
    processExit?: Promise<AgentProcessExit>,
  ): Promise<ConnectionInfo> {
    if (!process.stdout || !process.stdin) {
      throw new Error('Agent process missing stdio streams');
    }

    this.options.logger?.log(`Connecting to ACP agent ${agentId}`);
    const readable = Readable.toWeb(process.stdout) as ReadableStream<Uint8Array>;
    const writable = Writable.toWeb(process.stdin) as WritableStream<Uint8Array>;
    const stream = ndJsonStream(writable, readable);

    let client: AcpClient | null = null;
    const connection = new ClientSideConnection(
      (_agent: Agent) => {
        client = new AcpClient(
          new FileSystemHandler(workspaceCwd),
          new TerminalHandler(workspaceCwd),
          new PermissionHandler(this.options.getPermissionContext, {
            autoApproveAll: this.options.autoApprovePermissions,
            timeoutMs: resolveTimeouts(this.options.timeouts).permissionMs,
          }),
          this.sessionUpdateHandler,
        );
        return client;
      },
      stream,
    );

    const initResponse = await withProcessGuard(
      'initialize',
      processExit,
      withTimeout(
        'initialize',
        resolveTimeouts(this.options.timeouts).initializeMs,
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: {
            name: 'acp-runtime',
            version: '0.0.0',
          },
          clientCapabilities: {
            fs: {
              readTextFile: true,
              writeTextFile: true,
            },
            terminal: true,
          },
        }),
      ),
    );

    if (!client) {
      throw new Error('ACP client was not initialized.');
    }

    this.options.logger?.log(
      `ACP initialized. Agent: ${initResponse.agentInfo?.name ?? 'unknown'} v${initResponse.agentInfo?.version ?? '?'}`,
    );

    const info: ConnectionInfo = { connection, client, initResponse };
    this.connections.set(agentId, info);
    return info;
  }

  removeConnection(agentId: string): void {
    this.connections.delete(agentId);
  }

  dispose(): void {
    for (const info of this.connections.values()) {
      info.client.dispose();
    }
    this.connections.clear();
  }
}
