import type {
  SubprocessExecutor,
  SubprocessRequest,
  SubprocessResult,
} from './runtime.js';

export const SLOPIFY_GIT_NAME = 'Slopify';
export const SLOPIFY_GIT_EMAIL = 'slopify@localhost';

export interface AgentCheckpoint {
  runId: string;
  nodeId: string;
  attempt: number;
  sandboxName: string;
  baseCommit: string;
  commit: string;
  remote: string;
  ref: string;
}

export interface AgentCheckpointPreview {
  baseCommit: string;
  checkpointCommit: string;
  fileCount: number;
  files: string[];
  diff: string;
}

export interface AgentCheckpointResult {
  checkpointStatus: 'checkpointed' | 'no_changes';
  checkpoint: AgentCheckpoint;
  preview: AgentCheckpointPreview;
}

export interface CreateAgentCheckpointInput {
  workspaceCwd: string;
  sandboxName: string;
  baseCommit: string;
  runId: string;
  nodeId: string;
  attempt: number;
  signal?: AbortSignal;
}

export class GitPromotion {
  constructor(private readonly execute: SubprocessExecutor) {}

  async createAgentCheckpoint(input: CreateAgentCheckpointInput): Promise<AgentCheckpointResult> {
    const sandboxGit = (args: string[]): SubprocessRequest => ({
      command: 'sbx',
      args: ['exec', input.sandboxName, 'git', ...args],
      cwd: input.workspaceCwd,
      stdin: 'ignore',
      signal: input.signal,
    });

    await this.requireSuccess(sandboxGit(['add', '--all']), 'stage the Agent Checkpoint');
    await this.requireSuccess(sandboxGit([
      '-c', `user.name=${SLOPIFY_GIT_NAME}`,
      '-c', `user.email=${SLOPIFY_GIT_EMAIL}`,
      '-c', 'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '--no-verify',
      '-m', 'chore(slopify): create Agent Checkpoint',
      '-m', `Slopify-Run: ${input.runId}`,
      '-m', `Slopify-Node: ${input.nodeId}`,
      '-m', `Slopify-Attempt: ${input.attempt}`,
    ]), 'create the Agent Checkpoint');

    const remote = `sandbox-${input.sandboxName}`;
    const ref = `refs/slopify/checkpoints/${input.sandboxName}`;
    await this.requireSuccess({
      command: 'git',
      args: ['fetch', '--no-tags', remote, `HEAD:${ref}`],
      cwd: input.workspaceCwd,
      stdin: 'ignore',
      signal: input.signal,
    }, 'fetch the Agent Checkpoint');

    const checkpointCommit = (await this.requireSuccess({
      command: 'git',
      args: ['rev-parse', ref],
      cwd: input.workspaceCwd,
      stdin: 'ignore',
      signal: input.signal,
    }, 'read the Agent Checkpoint commit')).stdout.trim();
    if (!checkpointCommit) {
      throw new Error('Unable to read the Agent Checkpoint commit: git returned an empty commit id.');
    }

    const range = `${input.baseCommit}..${ref}`;
    const filesResult = await this.requireSuccess({
      command: 'git',
      args: ['diff', '--name-only', range],
      cwd: input.workspaceCwd,
      stdin: 'ignore',
      signal: input.signal,
    }, 'list the Agent Checkpoint files');
    const diffResult = await this.requireSuccess({
      command: 'git',
      args: ['diff', '--no-ext-diff', '--no-color', range],
      cwd: input.workspaceCwd,
      stdin: 'ignore',
      signal: input.signal,
    }, 'preview the Agent Checkpoint');

    const files = filesResult.stdout.split(/\r?\n/u).filter(Boolean);
    const checkpoint: AgentCheckpoint = {
      runId: input.runId,
      nodeId: input.nodeId,
      attempt: input.attempt,
      sandboxName: input.sandboxName,
      baseCommit: input.baseCommit,
      commit: checkpointCommit,
      remote,
      ref,
    };
    const preview: AgentCheckpointPreview = {
      baseCommit: input.baseCommit,
      checkpointCommit,
      fileCount: files.length,
      files,
      diff: diffResult.stdout,
    };
    return {
      checkpointStatus: files.length === 0 ? 'no_changes' : 'checkpointed',
      checkpoint,
      preview,
    };
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
