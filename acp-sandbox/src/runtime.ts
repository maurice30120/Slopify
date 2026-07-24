import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import {
  GitPromotion,
  type AgentCheckpoint,
  type AgentCheckpointPreview,
} from './gitPromotion.js';

export const MINIMUM_SBX_VERSION = '0.35.0';
export const DEFAULT_SANDBOX_CLEANUP_TIMEOUT_MS = 30_000;
export const DOCKER_SANDBOX_NETWORK_POLICY_CHOICES = ['Open', 'Balanced', 'Locked Down'] as const;

export type DockerSandboxNetworkPolicyChoice = typeof DOCKER_SANDBOX_NETWORK_POLICY_CHOICES[number];
export type DockerSandboxNetworkPolicyPreset = 'allow-all' | 'balanced' | 'deny-all';

export interface DockerSandboxRuntimeOptions {
  selectNetworkPolicy?: (
    choices: readonly DockerSandboxNetworkPolicyChoice[],
  ) => DockerSandboxNetworkPolicyChoice | undefined | Promise<DockerSandboxNetworkPolicyChoice | undefined>;
  reportNetworkPolicy?: (message: string) => void;
}

export interface SubprocessRequest {
  command: string;
  args: string[];
  cwd: string;
  stdin: 'ignore';
  observeOutput?: boolean;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface SubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type SubprocessExecutor = (request: SubprocessRequest) => Promise<SubprocessResult>;

export interface SandboxRunInput {
  workspaceCwd: string;
  runId: string;
  nodeId: string;
  attempt: number;
  prompt: string;
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  signal?: AbortSignal;
  timeoutMs?: number;
  workspaceEffects?: boolean;
  keepSandbox?: boolean;
  diagnosticsDirectory?: string;
  onSandboxRetained?: (sandbox: RetainedSandbox) => void | Promise<void>;
}

export interface SandboxRunResult {
  status?: 'no_changes';
  checkpointStatus: 'checkpointed' | 'no_changes';
  sandboxName: string;
  stdout: string;
  stderr: string;
  checkpoint: AgentCheckpoint;
  preview: AgentCheckpointPreview;
}

export interface RetainedSandboxCommands {
  run: string;
  shell: string;
  remove: string;
}

export interface RetainedSandbox {
  sandboxName: string;
  commands: RetainedSandboxCommands;
  diagnosticsPath?: string;
}

export type SandboxRunTerminalStatus = 'completed' | 'rejected' | 'cancelled' | 'failed' | 'timed_out';

export interface SandboxCleanupDiagnostic {
  attempted: boolean;
  timedOut?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface SandboxRunDiagnostic {
  sandboxName: string;
  runId: string;
  nodeId: string;
  attempt: number;
  status: SandboxRunTerminalStatus;
  startedAt: string;
  finishedAt: string;
  retained: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  commands?: RetainedSandboxCommands;
  retentionNotificationError?: string;
  cleanup: SandboxCleanupDiagnostic;
}

export class SandboxRunCancelledError extends Error {
  readonly code = 'sandbox_cancelled';

  constructor(sandboxName: string) {
    super(`Docker Sandbox "${sandboxName}" was cancelled.`);
    this.name = 'SandboxRunCancelledError';
  }
}

export class SandboxRunTimeoutError extends Error {
  readonly code = 'sandbox_timeout';

  constructor(sandboxName: string, readonly timeoutMs: number) {
    super(`Docker Sandbox "${sandboxName}" timed out after ${timeoutMs} ms.`);
    this.name = 'SandboxRunTimeoutError';
  }
}

/**
 * Orchestre l'exécution d'un nœud Codex dans un clone Docker Sandbox privé.
 *
 * Le runtime crée un Agent Checkpoint attribuable et le récupère côté hôte,
 * mais ne le promeut jamais. L'intégration et la Promotion appartiennent au
 * coordinateur du pipeline une fois le DAG complet.
 * Il transmet aussi les signaux d'arrêt à sbx, exporte les diagnostics, puis
 * conserve ou nettoie la ressource sans masquer le résultat du pipeline.
 *
 * Voir `docs/adr/0001-replace-sandcastle-with-docker-sandboxes.md` et
 * `docs/adr/0002-promote-one-multi-agent-change-set.md`.
 */
export class DockerSandboxRuntime {
  private networkPolicyReady?: Promise<void>;
  private readonly cleanupTimeoutMs: number;
  private readonly options: DockerSandboxRuntimeOptions;

  constructor(
    private readonly execute: SubprocessExecutor = createNodeSubprocessExecutor(),
    cleanupTimeoutMsOrOptions: number | DockerSandboxRuntimeOptions = DEFAULT_SANDBOX_CLEANUP_TIMEOUT_MS,
    options: DockerSandboxRuntimeOptions = {},
  ) {
    this.cleanupTimeoutMs = typeof cleanupTimeoutMsOrOptions === 'number'
      ? cleanupTimeoutMsOrOptions
      : DEFAULT_SANDBOX_CLEANUP_TIMEOUT_MS;
    this.options = typeof cleanupTimeoutMsOrOptions === 'number'
      ? options
      : cleanupTimeoutMsOrOptions;
  }

  async runCodex(input: SandboxRunInput): Promise<SandboxRunResult> {
    const sandboxName = stableSandboxName(input.runId, input.nodeId, input.attempt);
    const execution = createExecutionSignal(input.signal, input.timeoutMs);
    const startedAt = new Date().toISOString();
    let created = false;
    let stdout = '';
    let stderr = '';
    let terminalStatus: SandboxRunTerminalStatus = 'failed';
    let failure: unknown;

    try {
      await this.preflightWorkspace(input.workspaceCwd, input.workspaceEffects !== false, execution.signal);
      await this.requireSuccess({
        command: 'sbx',
        args: ['create', '--clone', '--name', sandboxName, 'codex', '.'],
        cwd: input.workspaceCwd,
        stdin: 'ignore',
        signal: execution.signal,
      }, 'create the Docker Sandbox');
      created = true;

      const baseCommit = (await this.requireSuccess({
        command: 'git',
        args: ['rev-parse', 'HEAD'],
        cwd: input.workspaceCwd,
        stdin: 'ignore',
        signal: execution.signal,
      }, 'read the host base commit')).stdout.trim();
      if (!baseCommit) {
        throw new Error('Unable to read the host base commit: git returned an empty commit id.');
      }

      const codexArgs = ['exec', sandboxName, 'codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', '--ephemeral', '--json'];
      if (input.model) codexArgs.push('--model', input.model);
      if (input.effort) codexArgs.push('--config', `model_reasoning_effort=${JSON.stringify(input.effort)}`);
      codexArgs.push(input.prompt);
      const codex = await this.execute({
        command: 'sbx',
        args: codexArgs,
        cwd: input.workspaceCwd,
        stdin: 'ignore',
        observeOutput: true,
        signal: execution.signal,
      });
      stdout = codex.stdout;
      stderr = codex.stderr;
      this.assertSuccess(codex, 'run Codex non-interactively');

      const checkpoint = await new GitPromotion(this.execute).createAgentCheckpoint({
        workspaceCwd: input.workspaceCwd,
        sandboxName,
        baseCommit,
        runId: input.runId,
        nodeId: input.nodeId,
        attempt: input.attempt,
        signal: execution.signal,
      });
      terminalStatus = 'completed';
      return {
        ...checkpoint,
        ...(checkpoint.checkpointStatus === 'no_changes' ? { status: 'no_changes' as const } : {}),
        sandboxName,
        stdout,
        stderr,
      };
    } catch (error: unknown) {
      failure = normalizeRunError(error, sandboxName, input.signal, execution.timedOut(), input.timeoutMs);
      terminalStatus = failure instanceof SandboxRunTimeoutError
        ? 'timed_out'
        : failure instanceof SandboxRunCancelledError
          ? 'cancelled'
          : 'failed';
      throw failure;
    } finally {
      execution.dispose();
      if (created) {
        const retained = input.keepSandbox === true;
        const commands = retained ? retainedSandboxCommands(sandboxName) : undefined;
        const diagnostic: SandboxRunDiagnostic = {
          sandboxName,
          runId: input.runId,
          nodeId: input.nodeId,
          attempt: input.attempt,
          status: terminalStatus,
          startedAt,
          finishedAt: new Date().toISOString(),
          retained,
          stdout,
          stderr,
          ...(failure === undefined ? {} : { error: formatUnknownError(failure) }),
          ...(commands ? { commands } : {}),
          cleanup: { attempted: !retained },
        };
        let diagnosticsPath = await writeSandboxDiagnostic(input.diagnosticsDirectory, diagnostic);

        if (retained) {
          try {
            await input.onSandboxRetained?.({
              sandboxName,
              commands: commands!,
              ...(diagnosticsPath ? { diagnosticsPath } : {}),
            });
          } catch (error: unknown) {
            diagnostic.retentionNotificationError = formatUnknownError(error);
            diagnosticsPath = await writeSandboxDiagnostic(input.diagnosticsDirectory, diagnostic) ?? diagnosticsPath;
          }
        } else {
          // `rm --force` rend le nettoyage répétable après une annulation ou
          // une erreur sans masquer le résultat principal du pipeline.
          diagnostic.cleanup = await this.cleanupSandbox(input.workspaceCwd, sandboxName);
          await writeSandboxDiagnostic(input.diagnosticsDirectory, diagnostic);
        }
      }
    }
  }

  async preflightWorkspace(cwd: string, workspaceEffects = true, signal?: AbortSignal): Promise<void> {
    await this.requireSuccess({ command: 'git', args: ['rev-parse', '--is-inside-work-tree'], cwd, stdin: 'ignore', signal }, 'verify that the workspace is a Git repository');
    if (workspaceEffects) {
      // `sbx --clone` ne voit pas les changements non commités. Autoriser un
      // workspace sale ferait donc calculer le Pipeline Change Set depuis une
      // base différente de celle que la Promotion doit avancer atomiquement.
      const status = await this.requireSuccess({ command: 'git', args: ['status', '--porcelain=v1'], cwd, stdin: 'ignore', signal }, 'inspect the Git workspace');
      if (status.stdout.trim()) {
        throw new Error('Docker Sandbox requires a clean Git workspace for workspace-writing pipelines: sbx --clone cannot see uncommitted changes, so safe Promotion is impossible. Commit or remove the local changes and retry.');
      }
    }
    const version = await this.requireSuccess({ command: 'sbx', args: ['version'], cwd, stdin: 'ignore', signal }, 'read the Docker Sandbox version');
    const actual = extractVersion(`${version.stdout}\n${version.stderr}`);
    if (!actual || compareVersions(actual, MINIMUM_SBX_VERSION) < 0) {
      throw new Error(`Docker Sandbox sbx ${MINIMUM_SBX_VERSION} or newer is required (found ${actual ?? 'an unknown version'}). Upgrade Docker Desktop and retry.`);
    }
    await this.requireCapability(cwd, ['create', '--help'], '--clone', signal);
    await this.requireCapability(cwd, ['ls', '--help'], '--json', signal);
    await this.requireCapability(cwd, ['policy', 'init', '--help'], 'policy init', signal, false);
    await this.ensureGlobalNetworkPolicy(cwd, signal);
  }

  private async ensureGlobalNetworkPolicy(cwd: string, signal?: AbortSignal): Promise<void> {
    if (!this.networkPolicyReady) {
      this.networkPolicyReady = this.initializeGlobalNetworkPolicy(cwd, signal);
    }
    try {
      await this.networkPolicyReady;
    } catch (error) {
      this.networkPolicyReady = undefined;
      throw error;
    }
  }

  private async initializeGlobalNetworkPolicy(cwd: string, signal?: AbortSignal): Promise<void> {
    const current = await this.execute({
      command: 'sbx',
      args: ['policy', 'ls', '--json'],
      cwd,
      stdin: 'ignore',
      signal,
    });
    if (current.exitCode === 0) {
      return;
    }

    const choice = await this.options.selectNetworkPolicy?.(DOCKER_SANDBOX_NETWORK_POLICY_CHOICES);
    if (!choice) {
      const detail = current.stderr.trim() || current.stdout.trim();
      const suffix = detail ? ` Docker reported: ${detail}` : '';
      throw new Error(`Docker Sandbox global network policy is not initialized.${suffix} Choose Open, Balanced or Locked Down in the interactive CLI, or initialize it with \`sbx policy init\`.`);
    }

    const preset = networkPolicyPreset(choice);
    await this.requireSuccess({
      command: 'sbx',
      args: ['policy', 'init', preset],
      cwd,
      stdin: 'ignore',
      signal,
    }, `initialize the Docker Sandbox global network policy as ${choice}`);
    this.options.reportNetworkPolicy?.(`Docker Sandbox global network policy initialized as ${choice}. Change it later with \`sbx policy\`.`);
  }

  private async cleanupSandbox(cwd: string, sandboxName: string): Promise<SandboxCleanupDiagnostic> {
    const cleanup = createExecutionSignal(undefined, this.cleanupTimeoutMs);
    try {
      const result = await this.execute({
        command: 'sbx',
        args: ['rm', '--force', sandboxName],
        cwd,
        stdin: 'ignore',
        signal: cleanup.signal,
      });
      if (cleanup.timedOut()) {
        return {
          attempted: true,
          timedOut: true,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          error: cleanupTimeoutMessage(this.cleanupTimeoutMs),
        };
      }
      return {
        attempted: true,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error: unknown) {
      return cleanup.timedOut()
        ? { attempted: true, timedOut: true, error: cleanupTimeoutMessage(this.cleanupTimeoutMs) }
        : { attempted: true, error: formatUnknownError(error) };
    } finally {
      cleanup.dispose();
    }
  }

  private async requireCapability(cwd: string, args: string[], capability: string, signal?: AbortSignal, matchOutput = true): Promise<void> {
    const result = await this.requireSuccess({ command: 'sbx', args, cwd, stdin: 'ignore', signal }, `verify Docker Sandbox capability ${capability}`);
    if (matchOutput && !`${result.stdout}\n${result.stderr}`.includes(capability)) {
      throw new Error(`Installed sbx does not provide the required ${capability} capability. Upgrade Docker Desktop and retry.`);
    }
  }

  private async requireSuccess(request: SubprocessRequest, action: string): Promise<SubprocessResult> {
    const result = await this.execute(request);
    this.assertSuccess(result, action);
    return result;
  }

  private assertSuccess(result: SubprocessResult, action: string): void {
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      throw new Error(`Unable to ${action}: ${detail}`);
    }
  }
}

export function stableSandboxName(runId: string, nodeId: string, attempt: number): string {
  const identity = `${runId}:${nodeId}:${attempt}`;
  const normalized = `slopify-${runId}-${nodeId}-${attempt}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  // La normalisation peut faire converger deux identités distinctes. Le hash
  // porte donc sur l'identité originale, pas sur le nom déjà normalisé.
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 8);
  return `${normalized.slice(0, 50).replace(/-+$/g, '')}-${hash}`;
}

export function retainedSandboxCommands(sandboxName: string): RetainedSandboxCommands {
  return {
    run: `sbx run --name ${sandboxName}`,
    shell: `sbx exec -it ${sandboxName} bash`,
    remove: `sbx rm --force ${sandboxName}`,
  };
}

export function createNodeSubprocessExecutor(): SubprocessExecutor {
  return request => new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: request.signal,
      env: request.env ? { ...process.env, ...request.env } : process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const resolveOnce = (result: SubprocessResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; if (request.observeOutput) process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { stderr += chunk; if (request.observeOutput) process.stderr.write(chunk); });
    child.once('error', error => {
      if (request.signal?.aborted) {
        resolveOnce({
          exitCode: 1,
          stdout,
          stderr: stderr || (error instanceof Error ? error.message : String(error)),
        });
        return;
      }
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('close', code => resolveOnce({ exitCode: code ?? 1, stdout, stderr }));
  });
}

function createExecutionSignal(parent: AbortSignal | undefined, timeoutMs: number | undefined): {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timeoutTriggered = false;
  const abortFromParent = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) {
    abortFromParent();
  } else {
    parent?.addEventListener('abort', abortFromParent, { once: true });
  }

  let timer: NodeJS.Timeout | undefined;
  if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timeoutTriggered = true;
      controller.abort();
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    dispose: () => {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

function normalizeRunError(
  error: unknown,
  sandboxName: string,
  parentSignal: AbortSignal | undefined,
  timedOut: boolean,
  timeoutMs: number | undefined,
): unknown {
  if (timedOut) {
    return new SandboxRunTimeoutError(sandboxName, timeoutMs ?? 0);
  }
  if (parentSignal?.aborted) {
    return new SandboxRunCancelledError(sandboxName);
  }
  return error;
}

async function writeSandboxDiagnostic(
  directory: string | undefined,
  diagnostic: SandboxRunDiagnostic,
): Promise<string | undefined> {
  if (!directory) {
    return undefined;
  }
  const filePath = path.join(directory, `${diagnostic.sandboxName}.json`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, `${JSON.stringify(diagnostic, null, 2)}\n`, 'utf8');
    return filePath;
  } catch {
    return undefined;
  }
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function cleanupTimeoutMessage(timeoutMs: number): string {
  return `Sandbox cleanup timed out after ${timeoutMs} ms.`;
}

function networkPolicyPreset(choice: DockerSandboxNetworkPolicyChoice): DockerSandboxNetworkPolicyPreset {
  switch (choice) {
    case 'Open': return 'allow-all';
    case 'Balanced': return 'balanced';
    case 'Locked Down': return 'deny-all';
  }
}

function extractVersion(output: string): string | undefined {
  return output.match(/\b(\d+)\.(\d+)\.(\d+)\b/)?.[0];
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}
