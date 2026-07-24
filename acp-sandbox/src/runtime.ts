import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

import { GitPromotion, type AgentCheckpoint, type AgentCheckpointPreview } from './gitPromotion.js';

export const MINIMUM_SBX_VERSION = '0.35.0';

export interface SubprocessRequest {
  command: string;
  args: string[];
  cwd: string;
  stdin: 'ignore';
  observeOutput?: boolean;
  signal?: AbortSignal;
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
  workspaceEffects?: boolean;
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

export class DockerSandboxRuntime {
  constructor(private readonly execute: SubprocessExecutor = createNodeSubprocessExecutor()) {}

  async runCodex(input: SandboxRunInput): Promise<SandboxRunResult> {
    await this.preflightWorkspace(input.workspaceCwd, input.workspaceEffects !== false, input.signal);
    const sandboxName = stableSandboxName(input.runId, input.nodeId, input.attempt);
    let created = false;
    try {
      await this.requireSuccess({ command: 'sbx', args: ['create', '--clone', '--name', sandboxName, 'codex', '.'], cwd: input.workspaceCwd, stdin: 'ignore', signal: input.signal }, 'create the Docker Sandbox');
      created = true;
      const baseCommit = (await this.requireSuccess({ command: 'git', args: ['rev-parse', 'HEAD'], cwd: input.workspaceCwd, stdin: 'ignore', signal: input.signal }, 'read the host base commit')).stdout.trim();
      if (!baseCommit) {
        throw new Error('Unable to read the host base commit: git returned an empty commit id.');
      }

      const codexArgs = ['exec', sandboxName, 'codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', '--ephemeral', '--json'];
      if (input.model) codexArgs.push('--model', input.model);
      if (input.effort) codexArgs.push('--config', `model_reasoning_effort=${JSON.stringify(input.effort)}`);
      codexArgs.push(input.prompt);
      const codex = await this.requireSuccess({ command: 'sbx', args: codexArgs, cwd: input.workspaceCwd, stdin: 'ignore', observeOutput: true, signal: input.signal }, 'run Codex non-interactively');

      const checkpoint = await new GitPromotion(this.execute).createAgentCheckpoint({
        workspaceCwd: input.workspaceCwd,
        sandboxName,
        baseCommit,
        runId: input.runId,
        nodeId: input.nodeId,
        attempt: input.attempt,
        signal: input.signal,
      });
      return {
        ...checkpoint,
        ...(checkpoint.checkpointStatus === 'no_changes' ? { status: 'no_changes' as const } : {}),
        sandboxName,
        stdout: codex.stdout,
        stderr: codex.stderr,
      };
    } finally {
      if (created) {
        await this.execute({ command: 'sbx', args: ['rm', '--force', sandboxName], cwd: input.workspaceCwd, stdin: 'ignore' });
      }
    }
  }

  async preflightWorkspace(cwd: string, workspaceEffects = true, signal?: AbortSignal): Promise<void> {
    await this.requireSuccess({ command: 'git', args: ['rev-parse', '--is-inside-work-tree'], cwd, stdin: 'ignore', signal }, 'verify that the workspace is a Git repository');
    if (workspaceEffects) {
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
  }

  private async requireCapability(cwd: string, args: string[], capability: string, signal?: AbortSignal, matchOutput = true): Promise<void> {
    const result = await this.requireSuccess({ command: 'sbx', args, cwd, stdin: 'ignore', signal }, `verify Docker Sandbox capability ${capability}`);
    if (matchOutput && !`${result.stdout}\n${result.stderr}`.includes(capability)) {
      throw new Error(`Installed sbx does not provide the required ${capability} capability. Upgrade Docker Desktop and retry.`);
    }
  }

  private async requireSuccess(request: SubprocessRequest, action: string): Promise<SubprocessResult> {
    const result = await this.execute(request);
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      throw new Error(`Unable to ${action}: ${detail}`);
    }
    return result;
  }
}

export function stableSandboxName(runId: string, nodeId: string, attempt: number): string {
  const identity = `${runId}:${nodeId}:${attempt}`;
  const normalized = `slopify-${runId}-${nodeId}-${attempt}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 8);
  return `${normalized.slice(0, 50).replace(/-+$/g, '')}-${hash}`;
}

export function createNodeSubprocessExecutor(): SubprocessExecutor {
  return request => new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: request.signal,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; if (request.observeOutput) process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { stderr += chunk; if (request.observeOutput) process.stderr.write(chunk); });
    child.once('error', reject);
    child.once('close', code => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
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
