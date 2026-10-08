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

/** Composant AcpClient qui coordonne une étape observable du cycle de vie du pipeline et en préserve les invariants. */
export class AcpClient implements Client {
/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
  constructor(
    private readonly fsHandler: FileSystemHandler,
    private readonly terminalHandler: TerminalHandler,
    private readonly permissionHandler: PermissionHandler,
    private readonly sessionUpdateHandler: SessionUpdateHandler,
  ) {}

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return this.permissionHandler.requestPermission(params);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.sessionUpdateHandler.handleUpdate(params);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    return this.fsHandler.writeTextFile(params);
  }

/** Valide ou résout les données de cette étape du cycle de vie ; les entrées invalides restent signalées au point d'appel. */
  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return this.fsHandler.readTextFile(params);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    return this.terminalHandler.createTerminal(params);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    return this.terminalHandler.terminalOutput(params);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    return this.terminalHandler.waitForTerminalExit(params);
  }

/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    return this.terminalHandler.killTerminal(params);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    return this.terminalHandler.releaseTerminal(params);
  }

/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  dispose(): void {
    this.terminalHandler.dispose();
  }
}
