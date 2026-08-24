import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';

import type { Logger } from '../types.js';
import { isCodexAcpCommand, normalizeCodexModelsCacheForLegacyCli } from './codexModelsCacheCompat.js';

export interface ProcessAgentConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  loginShell?: boolean;
}

export interface AgentInstance {
  id: string;
  name: string;
  process: ChildProcess;
  config: ProcessAgentConfig;
}

export interface AgentProcessExit {
  agentId: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

/**
 * Possède les processus ACP locaux et impose une terminaison bornée. Le manager
 * est la seule couche autorisée à lancer ou arrêter ces processus, afin que les
 * connexions ne survivent pas au run qui les a créées.
 */
export class AgentProcessManager extends EventEmitter {
  private readonly agents = new Map<string, AgentInstance>();
  private nextId = 1;

  constructor(private readonly logger?: Logger) {
    super();
  }

  spawnAgent(name: string, config: ProcessAgentConfig, cwd?: string): AgentInstance {
    const id = `agent_${this.nextId++}`;
    this.logger?.log(`Spawning ACP agent "${name}" (${id}): ${config.command} ${(config.args ?? []).join(' ')}`);
    if (isCodexAcpCommand(config.command, config.args ?? [])) {
      normalizeCodexModelsCacheForLegacyCli(this.logger);
    }

    const child = process.platform === 'win32'
      ? spawn(config.command, config.args ?? [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...(config.env ?? {}) },
          cwd,
          shell: true,
        })
      : spawnUnix(config, cwd, this.logger);

    const instance: AgentInstance = { id, name, process: child, config };
    this.agents.set(id, instance);

    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        this.logger?.log(`[${name} stderr] ${line}`);
      }
    });

    child.on('error', error => {
      this.logger?.error(`Agent "${name}" process error`, error);
      this.emit('agent-error', { agentId: id, error });
    });

    child.on('close', (code, signal) => {
      this.logger?.log(`Agent "${name}" exited (code=${code}, signal=${signal})`);
      this.agents.delete(id);
      this.emit('agent-closed', { agentId: id, code, signal });
    });

    return instance;
  }

  killAgent(agentId: string): boolean {
    const instance = this.agents.get(agentId);
    if (!instance) {
      return false;
    }

    try {
      instance.process.kill('SIGTERM');
      // Certains agents ne traitent pas SIGTERM lorsqu'ils sont bloqués dans un
      // appel d'outil. La limite évite qu'une annulation conserve indéfiniment le
      // processus et ses descripteurs de fichiers.
      const forceKillTimer = setTimeout(() => {
        if (instance.process.exitCode === null) {
          instance.process.kill('SIGKILL');
        }
      }, 5000);
      forceKillTimer.unref?.();
    } catch (e: unknown) {
      this.logger?.error(`Failed to kill agent ${agentId}`, e);
    }

    this.agents.delete(agentId);
    return true;
  }

  killAll(): void {
    for (const id of this.agents.keys()) {
      this.killAgent(id);
    }
  }

  dispose(): void {
    this.killAll();
    this.removeAllListeners();
  }
}

export function observeAgentProcessExit(instance: AgentInstance): Promise<AgentProcessExit> {
  if (
    typeof instance.process.once !== 'function'
    || typeof instance.process.off !== 'function'
  ) {
    return new Promise(() => {});
  }
  return new Promise(resolve => {
    let settled = false;
    const settle = (exit: AgentProcessExit): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(exit);
    };
    const onError = (error: Error): void => {
      settle({
        agentId: instance.id,
        code: null,
        signal: null,
        error,
      });
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      settle({
        agentId: instance.id,
        code,
        signal,
      });
    };
    const cleanup = (): void => {
      instance.process.off('error', onError);
      instance.process.off('close', onClose);
    };
    instance.process.once('error', onError);
    instance.process.once('close', onClose);
  });
}

function spawnUnix(config: ProcessAgentConfig, cwd: string | undefined, logger?: Logger): ChildProcess {
  const { shell, useLoginFlag } = resolveUnixShell(logger);
  const commandStr = [config.command, ...(config.args ?? [])].map(shellEscape).join(' ');
  const loginShell = config.loginShell ?? false;
  const shellArgs = useLoginFlag && loginShell ? ['-l', '-c', commandStr] : ['-c', commandStr];
  logger?.log(`Using shell: ${shell} ${shellArgs.join(' ')}`);
  return spawn(shell, shellArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(config.env ?? {}) },
    cwd,
  });
}

function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function resolveUnixShell(logger?: Logger): { shell: string; useLoginFlag: boolean } {
  const userShell = process.env.SHELL;
  if (userShell) {
    const base = userShell.split('/').pop() ?? '';
    if (['zsh', 'bash', 'ksh'].includes(base)) {
      return { shell: userShell, useLoginFlag: true };
    }
    if (['fish', 'sh', 'dash'].includes(base)) {
      return { shell: userShell, useLoginFlag: false };
    }
    logger?.log(`User shell "${userShell}" is not POSIX-compatible, falling back to bash/sh`);
  }
  if (existsSync('/bin/bash')) {
    return { shell: '/bin/bash', useLoginFlag: true };
  }
  if (existsSync('/usr/bin/bash')) {
    return { shell: '/usr/bin/bash', useLoginFlag: true };
  }
  return { shell: '/bin/sh', useLoginFlag: false };
}
