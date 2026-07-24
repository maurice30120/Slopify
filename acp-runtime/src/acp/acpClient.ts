import type {
  Client,
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

import { FileSystemHandler } from './fileSystemHandler.js';
import { PermissionHandler } from './permissionHandler.js';
import { SessionUpdateHandler } from './sessionUpdateHandler.js';
import { TerminalHandler } from './terminalHandler.js';

export class AcpClient implements Client {
  constructor(
    private readonly fsHandler: FileSystemHandler,
    private readonly terminalHandler: TerminalHandler,
    private readonly permissionHandler: PermissionHandler,
    private readonly sessionUpdateHandler: SessionUpdateHandler,
  ) {}

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return this.permissionHandler.requestPermission(params);
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.sessionUpdateHandler.handleUpdate(params);
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    return this.fsHandler.writeTextFile(params);
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return this.fsHandler.readTextFile(params);
  }

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    return this.terminalHandler.createTerminal(params);
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    return this.terminalHandler.terminalOutput(params);
  }

  async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    return this.terminalHandler.waitForTerminalExit(params);
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    return this.terminalHandler.killTerminal(params);
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    return this.terminalHandler.releaseTerminal(params);
  }

  dispose(): void {
    this.terminalHandler.dispose();
  }
}
