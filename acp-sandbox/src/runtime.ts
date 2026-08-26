import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import {
  GitPromotion,
  type AgentCheckpoint,
  type AgentCheckpointPreview,
  type AgentCheckpointResult,
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
  onStateChange?: (state: SandboxRunState) => void | Promise<void>;
  resumeState?: SandboxRunState;
  dependencyCheckpoints?: readonly AgentCheckpointResult[];
}

export interface SandboxRunState {
  sandboxName: string;
  sandboxId?: string;
  runId: string;
  nodeId: string;
  attempt: number;
  baseCommit: string;
  integrationState: 'sandbox_created' | 'checkpointed';
  resourceState: 'active' | 'retained' | 'removed';
  checkpoint?: AgentCheckpointResult;
  stdout?: string;
  stderr?: string;
  diagnosticsPath?: string;
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

export interface SandboxResumeSnapshot {
  workspaceCwd: string;
  sandboxName: string;
  sandboxId?: string;
  baseCommit: string;
  checkpointCommit?: string;
}

export type SandboxReconciliationResult =
  | {
      status: 'reusable';
      sandboxName: string;
      sandboxId?: string;
      observedCommit: string;
    }
  | {
      status: 'diverged';
      sandboxName: string;
      diagnostic: string;
    }
  | {
      status: 'removed';
      sandboxName: string;
    };

export class SandboxResumeDivergenceError extends Error {
  readonly code = 'sandbox_resume_divergence';

  constructor(readonly diagnostic: string) {
    super(diagnostic);
    this.name = 'SandboxResumeDivergenceError';
  }
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
 * Voir les ADR 0001 et 0002 sous `docs/adr/`.
 */
export class DockerSandboxRuntime {
  private networkPolicyReady?: Promise<void>;
  private networkPolicyAbort?: AbortController;
  private activePreflights = 0;
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
    const sandboxName = input.resumeState?.sandboxName ?? stableSandboxName(input.runId, input.nodeId, input.attempt);
    const execution = createExecutionSignal(input.signal, input.timeoutMs);
    const startedAt = new Date().toISOString();
    let created = false;
    let stdout = '';
    let stderr = '';
    let terminalStatus: SandboxRunTerminalStatus = 'failed';
    let failure: unknown;
    let durableState: SandboxRunState | undefined;

    try {
      await this.preflightWorkspace(
        input.workspaceCwd,
        input.workspaceEffects !== false,
        execution.signal,
        input.resumeState ? [] : [sandboxName],
      );
      let baseCommit: string;
      if (input.resumeState) {
        baseCommit = input.resumeState.baseCommit;
        if (input.resumeState.resourceState === 'removed' && input.resumeState.checkpoint) {
          durableState = { ...input.resumeState };
        } else {
          const reconciled = await this.reconcileSandbox({
            workspaceCwd: input.workspaceCwd,
            sandboxName: input.resumeState.sandboxName,
            sandboxId: input.resumeState.sandboxId,
            baseCommit: input.resumeState.baseCommit,
            checkpointCommit: input.resumeState.checkpoint?.checkpoint.commit,
          });
          if (reconciled.status === 'diverged') throw new SandboxResumeDivergenceError(reconciled.diagnostic);
          created = reconciled.status === 'reusable';
          durableState = {
            ...input.resumeState,
            resourceState: reconciled.status === 'removed' ? 'removed' : input.resumeState.resourceState,
            ...(reconciled.status === 'reusable' && reconciled.sandboxId ? { sandboxId: reconciled.sandboxId } : {}),
          };
        }
        stdout = durableState.stdout ?? '';
        stderr = durableState.stderr ?? '';
      } else {
        baseCommit = (await this.requireSuccess({
          command: 'git',
          args: ['rev-parse', 'HEAD'],
          cwd: input.workspaceCwd,
          stdin: 'ignore',
          signal: execution.signal,
        }, 'read the host base commit')).stdout.trim();
        if (!baseCommit) throw new Error('Unable to read the host base commit: git returned an empty commit id.');
        await this.requireSuccess({
          command: 'sbx',
          args: ['create', '--clone', '--name', sandboxName, 'codex', '.'],
          cwd: input.workspaceCwd,
          stdin: 'ignore',
          signal: execution.signal,
        }, 'create the Docker Sandbox');
        created = true;
        if (input.dependencyCheckpoints?.length) {
          const composed = await new GitPromotion(this.execute).integrateAgentCheckpoints({
            workspaceCwd: input.workspaceCwd,
            runId: input.runId,
            checkpoints: input.dependencyCheckpoints,
            signal: execution.signal,
          });
          const remote = `sandbox-${sandboxName}`;
          const dependencyRef = `refs/slopify/dependencies/${input.runId}/${input.nodeId}/${input.attempt}`;
          await this.requireSuccess({
            command: 'git', args: ['push', '--force', remote, `${composed.changeSet.commit}:${dependencyRef}`],
            cwd: input.workspaceCwd, stdin: 'ignore', signal: execution.signal,
          }, 'publish dependency checkpoints to the descendant sandbox');
          await this.requireSuccess({
            command: 'sbx', args: ['exec', sandboxName, 'git', 'reset', '--hard', dependencyRef],
            cwd: input.workspaceCwd, stdin: 'ignore', signal: execution.signal,
          }, 'prepare the descendant sandbox from dependency checkpoints');
        }
        const sandboxId = await this.readSandboxId(input.workspaceCwd, sandboxName, execution.signal);
        durableState = {
          sandboxName,
          ...(sandboxId ? { sandboxId } : {}),
          runId: input.runId,
          nodeId: input.nodeId,
          attempt: input.attempt,
          baseCommit,
          integrationState: 'sandbox_created',
          resourceState: 'active',
          ...(input.diagnosticsDirectory
            ? { diagnosticsPath: path.join(input.diagnosticsDirectory, `${sandboxName}.json`) }
            : {}),
        };
      }
      await input.onStateChange?.(durableState);

      if (durableState.checkpoint) {
        terminalStatus = 'completed';
        return {
          ...durableState.checkpoint,
          ...(durableState.checkpoint.checkpointStatus === 'no_changes' ? { status: 'no_changes' as const } : {}),
          sandboxName,
          stdout,
          stderr,
        };
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
      durableState = {
        ...durableState,
        integrationState: 'checkpointed',
        checkpoint,
        stdout,
        stderr,
      };
      await input.onStateChange?.(durableState);
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
        if (durableState) {
          durableState = {
            ...durableState,
            resourceState: retained ? 'retained' : 'removed',
            ...(diagnosticsPath ? { diagnosticsPath } : {}),
          };
          await input.onStateChange?.(durableState);
        }
      }
    }
  }

  /**
   * Compare un état durable avec la ressource réellement exposée par Docker.
   * Cette opération est volontairement en lecture seule : un doute suspend la
   * reprise et ne crée, ne supprime ni ne promeut jamais implicitement.
   */
  async reconcileSandbox(input: SandboxResumeSnapshot): Promise<SandboxReconciliationResult> {
    const listed = await this.requireSuccess({
      command: 'sbx',
      args: ['ls', '--json'],
      cwd: input.workspaceCwd,
      stdin: 'ignore',
    }, 'list Docker Sandboxes for pipeline resume');
    const resources = parseSandboxList(listed.stdout);
    const observed = resources.find(resource => resource.name === input.sandboxName);
    if (!observed) {
      if (input.checkpointCommit) {
        return { status: 'removed', sandboxName: input.sandboxName };
      }
      return {
        status: 'diverged',
        sandboxName: input.sandboxName,
        diagnostic: `Sandbox resume divergence: ${input.sandboxName} is absent from sbx ls --json.`,
      };
    }
    if (input.sandboxId && observed.id !== input.sandboxId) {
      return {
        status: 'diverged',
        sandboxName: input.sandboxName,
        diagnostic: `Sandbox identity divergence: observed ${observed.id ?? 'no stable id'}, expected ${input.sandboxId}.`,
      };
    }

    const head = (await this.requireSuccess({
      command: 'sbx',
      args: ['exec', input.sandboxName, 'git', 'rev-parse', 'HEAD'],
      cwd: input.workspaceCwd,
      stdin: 'ignore',
    }, `read resumed Docker Sandbox ${input.sandboxName} commit`)).stdout.trim();
    const expectedHead = input.checkpointCommit ?? input.baseCommit;
    if (head !== expectedHead) {
      return {
        status: 'diverged',
        sandboxName: input.sandboxName,
        diagnostic: `Sandbox base divergence: expected persisted base ${input.baseCommit} with head ${expectedHead}, observed ${head || 'an empty commit'}.`,
      };
    }
    if (input.checkpointCommit) {
      const ancestry = await this.execute({
        command: 'sbx',
        args: ['exec', input.sandboxName, 'git', 'merge-base', '--is-ancestor', input.baseCommit, input.checkpointCommit],
        cwd: input.workspaceCwd,
        stdin: 'ignore',
      });
      if (ancestry.exitCode !== 0) {
        return {
          status: 'diverged',
          sandboxName: input.sandboxName,
          diagnostic: `Sandbox base divergence: persisted base ${input.baseCommit} is not an ancestor of checkpoint ${input.checkpointCommit}.`,
        };
      }
    }
    const worktree = await this.requireSuccess({
      command: 'sbx',
      args: ['exec', input.sandboxName, 'git', 'status', '--porcelain=v1'],
      cwd: input.workspaceCwd,
      stdin: 'ignore',
    }, `inspect resumed Docker Sandbox ${input.sandboxName} worktree`);
    if (worktree.stdout.trim()) {
      return {
        status: 'diverged',
        sandboxName: input.sandboxName,
        diagnostic: `Sandbox worktree divergence: ${input.sandboxName} contains uncheckpointed changes and cannot be resumed deterministically.`,
      };
    }
    return {
      status: 'reusable',
      sandboxName: input.sandboxName,
      ...(observed.id ? { sandboxId: observed.id } : {}),
      observedCommit: head,
    };
  }

  async preflightWorkspace(
    cwd: string,
    workspaceEffects = true,
    signal?: AbortSignal,
    plannedSandboxNames: readonly string[] = [],
  ): Promise<void> {
    this.activePreflights += 1;
    try {
      await this.requireSuccess({ command: 'git', args: ['rev-parse', '--is-inside-work-tree'], cwd, stdin: 'ignore', signal }, 'verify that the workspace is a Git repository');
      if (workspaceEffects) {
        // `sbx --clone` ne voit pas les changements non commités. Autoriser un
        // workspace sale ferait donc calculer le Pipeline Change Set depuis une
        // base différente de celle que la Promotion doit avancer atomiquement.
        const status = await this.requireSuccess({
          command: 'git',
          args: [
            'status',
            '--porcelain=v1',
            '--',
            '.',
            ':(exclude).acp/logs',
            ':(exclude).acp/runs-v3',
          ],
          cwd,
          stdin: 'ignore',
          signal,
        }, 'inspect the Git workspace');
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
      if (plannedSandboxNames.length > 0) {
        const listed = await this.requireSuccess({
          command: 'sbx', args: ['ls', '--json'], cwd, stdin: 'ignore', signal,
        }, 'check planned Docker Sandbox names');
        const occupiedNames = new Set(parseSandboxList(listed.stdout).map(resource => resource.name));
        const collision = plannedSandboxNames.find(name => occupiedNames.has(name));
        if (collision) {
          throw new Error(`Docker Sandbox name collision: ${collision} already exists and cannot be reused without matching persisted state.`);
        }
      }
      await this.requireCapability(cwd, ['policy', 'init', '--help'], 'policy init', signal, false);
      await this.ensureGlobalNetworkPolicy(cwd, signal);
    } finally {
      this.activePreflights -= 1;
      if (signal?.aborted && this.activePreflights === 0) {
        this.networkPolicyAbort?.abort(signal.reason);
      }
    }
  }

  private async ensureGlobalNetworkPolicy(cwd: string, signal?: AbortSignal): Promise<void> {
    if (!this.networkPolicyReady) {
      const abort = new AbortController();
      const initialization = this.initializeGlobalNetworkPolicy(cwd, abort.signal);
      this.networkPolicyAbort = abort;
      this.networkPolicyReady = initialization;
      void initialization.catch(() => {
        if (this.networkPolicyReady === initialization) {
          this.networkPolicyReady = undefined;
          this.networkPolicyAbort = undefined;
        }
      });
    }
    await waitForPromise(this.networkPolicyReady, signal);
  }

  private async initializeGlobalNetworkPolicy(cwd: string, signal: AbortSignal): Promise<void> {
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

  private async readSandboxId(cwd: string, sandboxName: string, signal?: AbortSignal): Promise<string | undefined> {
    const listed = await this.execute({ command: 'sbx', args: ['ls', '--json'], cwd, stdin: 'ignore', signal });
    if (listed.exitCode !== 0 || !listed.stdout.trim()) return undefined;
    try {
      return parseSandboxList(listed.stdout).find(resource => resource.name === sandboxName)?.id;
    } catch {
      // Older or vendor-patched sbx builds may expose a non-standard payload.
      // The deterministic name remains the minimum identity until reconciliation.
      return undefined;
    }
  }
}

interface ListedSandbox {
  name: string;
  id?: string;
}

function parseSandboxList(output: string): ListedSandbox[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error: unknown) {
    throw new Error(`Unable to parse sbx ls --json while resuming a pipeline: ${formatUnknownError(error)}`);
  }

  const entries = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.sandboxes)
      ? parsed.sandboxes
      : [];
  return entries.flatMap(entry => {
    if (!isRecord(entry)) return [];
    const name = stringProperty(entry, 'name', 'Name');
    if (!name) return [];
    const id = stringProperty(entry, 'id', 'ID', 'Id');
    return [{ name, ...(id ? { id } : {}) }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringProperty(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  return undefined;
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

function waitForPromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
}

function extractVersion(output: string): string | undefined {
  return output.match(/\bv?(\d+\.\d+\.\d+)\b/i)?.[1];
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}
