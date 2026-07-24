import { spawn, type ChildProcess } from 'node:child_process';

import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk';

import { filterEnv, validatePath } from './security.js';

interface ManagedTerminal {
  id: string;
  process: ChildProcess;
  output: string;
  truncated: boolean;
  outputByteLimit: number;
  exitCode: number | null;
  exitSignal: string | null;
  exited: boolean;
  exitPromise: Promise<void>;
}

export class TerminalHandler {
  private readonly terminals = new Map<string, ManagedTerminal>();
  private nextId = 1;

  constructor(private readonly workspaceRoot: string) {}

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const terminalId = `term_${this.nextId++}`;
    const outputByteLimit = params.outputByteLimit ?? 1024 * 1024;
    const cwd = params.cwd ? validatePath(params.cwd, this.workspaceRoot) : this.workspaceRoot;
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };

    if (params.env) {
      const requestedEnv: Record<string, string> = {};
      for (const variable of params.env) {
        requestedEnv[variable.name] = variable.value;
      }
      Object.assign(env, filterEnv(requestedEnv));
    }

    const child = spawn(params.command, params.args ?? [], {
      cwd,
      env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    let truncated = false;

    const appendOutput = (data: Buffer) => {
      output += data.toString();
      const byteLength = Buffer.byteLength(output, 'utf8');
      if (byteLength <= outputByteLimit) {
        return;
      }
      const excess = byteLength - outputByteLimit;
      let cutPoint = 0;
      let bytes = 0;
      for (let index = 0; index < output.length; index++) {
        bytes += Buffer.byteLength(output[index], 'utf8');
        if (bytes >= excess) {
          cutPoint = index + 1;
          break;
        }
      }
      output = output.substring(cutPoint);
      truncated = true;
    };

    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);

    const exitPromise = new Promise<void>((resolve) => {
      child.on('close', (code, signal) => {
        const managed = this.terminals.get(terminalId);
        if (managed) {
          managed.output = output;
          managed.truncated = truncated;
          managed.exitCode = code;
          managed.exitSignal = signal;
          managed.exited = true;
        }
        resolve();
      });
      child.on('error', () => resolve());
    });

    const managed: ManagedTerminal = {
      id: terminalId,
      process: child,
      output,
      truncated,
      outputByteLimit,
      exitCode: null,
      exitSignal: null,
      exited: false,
      exitPromise,
    };

    const syncOutput = () => {
      managed.output = output;
      managed.truncated = truncated;
    };
    child.stdout?.on('data', syncOutput);
    child.stderr?.on('data', syncOutput);

    this.terminals.set(terminalId, managed);
    return { terminalId };
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const managed = this.getTerminal(params.terminalId);
    const response: TerminalOutputResponse = {
      output: managed.output,
      truncated: managed.truncated,
    };

    if (managed.exited) {
      response.exitStatus = {
        exitCode: managed.exitCode,
        signal: managed.exitSignal,
      };
    }

    return response;
  }

  async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const managed = this.getTerminal(params.terminalId);
    await managed.exitPromise;
    return {
      exitCode: managed.exitCode,
      signal: managed.exitSignal,
    };
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    const managed = this.getTerminal(params.terminalId);
    if (!managed.exited) {
      managed.process.kill('SIGTERM');
    }
    return {};
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    const managed = this.getTerminal(params.terminalId);
    if (!managed.exited) {
      managed.process.kill('SIGTERM');
    }
    this.terminals.delete(params.terminalId);
    return {};
  }

  dispose(): void {
    for (const managed of this.terminals.values()) {
      if (!managed.exited) {
        managed.process.kill('SIGKILL');
      }
    }
    this.terminals.clear();
  }

  private getTerminal(terminalId: string): ManagedTerminal {
    const managed = this.terminals.get(terminalId);
    if (!managed) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }
    return managed;
  }
}
