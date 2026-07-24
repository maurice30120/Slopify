import type {
  SubprocessExecutor,
  SubprocessRequest,
  SubprocessResult,
} from './runtime.js';

export const SLOPIFY_GIT_NAME = 'Slopify';
export const SLOPIFY_GIT_EMAIL = 'slopify@localhost';

export const PROMOTION_POLICIES = ['discard', 'ask', 'auto-apply', 'auto-reject'] as const;

export type PromotionPolicy = typeof PROMOTION_POLICIES[number];
export type PromotionDecision = 'apply' | 'reject' | 'cancel';
export type PromotionStatus = 'applied' | 'no_changes' | 'rejected' | 'cancelled';

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

export interface PromotionRequest {
  checkpoint: AgentCheckpoint;
  preview: AgentCheckpointPreview;
}

export type PromotionDecider = (
  request: PromotionRequest,
) => PromotionDecision | Promise<PromotionDecision>;

export interface PromotePipelineChangeSetInput extends PromotionRequest {
  workspaceCwd: string;
  policy: PromotionPolicy;
  decide?: PromotionDecider;
  signal?: AbortSignal;
}

export interface PromotionResult extends PromotionRequest {
  status: PromotionStatus;
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

  async promotePipelineChangeSet(input: PromotePipelineChangeSetInput): Promise<PromotionResult> {
    const request: PromotionRequest = {
      checkpoint: input.checkpoint,
      preview: input.preview,
    };

    if (input.preview.fileCount === 0) {
      return { ...request, status: 'no_changes' };
    }

    const decision = await this.resolveDecision(input, request);
    if (decision === 'reject') {
      return { ...request, status: 'rejected' };
    }
    if (decision === 'cancel') {
      return { ...request, status: 'cancelled' };
    }

    await this.requireSuccess({
      command: 'git',
      args: ['merge-base', '--is-ancestor', input.checkpoint.baseCommit, input.checkpoint.ref],
      cwd: input.workspaceCwd,
      stdin: 'ignore',
      signal: input.signal,
    }, 'verify the Pipeline Change Set ancestry');

    const status = await this.requireSuccess({
      command: 'git',
      args: ['status', '--porcelain=v1'],
      cwd: input.workspaceCwd,
      stdin: 'ignore',
      signal: input.signal,
    }, 'revalidate the host workspace before Promotion');
    if (status.stdout.trim()) {
      throw new Error('Unable to promote the Pipeline Change Set: the host workspace changed after the sandbox run. No changes were applied.');
    }

    const currentHead = (await this.requireSuccess({
      command: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd: input.workspaceCwd,
      stdin: 'ignore',
      signal: input.signal,
    }, 'revalidate the host Git base before Promotion')).stdout.trim();
    if (currentHead !== input.checkpoint.baseCommit) {
      throw new Error(`Unable to promote the Pipeline Change Set: the host Git base diverged from ${input.checkpoint.baseCommit} to ${currentHead || 'an unknown commit'}. No changes were applied.`);
    }

    await this.requireSuccess({
      command: 'git',
      args: ['merge', '--ff-only', '--no-edit', input.checkpoint.ref],
      cwd: input.workspaceCwd,
      stdin: 'ignore',
      signal: input.signal,
    }, 'promote the Pipeline Change Set atomically');

    return { ...request, status: 'applied' };
  }

  private async resolveDecision(
    input: PromotePipelineChangeSetInput,
    request: PromotionRequest,
  ): Promise<PromotionDecision> {
    switch (input.policy) {
      case 'auto-apply':
        return 'apply';
      case 'discard':
      case 'auto-reject':
        return 'reject';
      case 'ask':
        if (input.signal?.aborted || !input.decide) {
          return 'cancel';
        }
        try {
          const decision = await input.decide(request);
          return input.signal?.aborted ? 'cancel' : decision;
        } catch (error) {
          if (input.signal?.aborted) {
            return 'cancel';
          }
          throw error;
        }
      default:
        throw new Error(`Unsupported Promotion policy: ${String(input.policy)}. Expected discard, ask, auto-apply or auto-reject.`);
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
