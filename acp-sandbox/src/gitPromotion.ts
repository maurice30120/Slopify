import { createHash } from 'node:crypto';

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

export interface IntegrationConflict {
  runId: string;
  baseCommit: string;
  currentCommit: string;
  incomingCheckpoint: AgentCheckpoint;
  checkpoints: AgentCheckpoint[];
  files: string[];
}

export class IntegrationConflictError extends Error {
  readonly code = 'integration_conflict';

  constructor(readonly conflict: IntegrationConflict) {
    const checkpoints = conflict.checkpoints
      .map(checkpoint => `${checkpoint.nodeId}#${checkpoint.attempt}`)
      .join(', ');
    const files = conflict.files.length > 0 ? conflict.files.join(', ') : 'unknown files';
    super(
      `Integration Conflict while applying Agent Checkpoint "${conflict.incomingCheckpoint.nodeId}" `
      + `attempt ${conflict.incomingCheckpoint.attempt}. Checkpoints: ${checkpoints}. Files: ${files}.`,
    );
    this.name = 'IntegrationConflictError';
  }
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

export interface PipelineChangeSet {
  runId: string;
  baseCommit: string;
  commit: string;
  ref: string;
  integratedNodeIds: string[];
}

export interface PipelineChangeSetPreview {
  baseCommit: string;
  changeSetCommit: string;
  fileCount: number;
  files: string[];
  diff: string;
}

export interface PipelineChangeSetResult {
  changeSet: PipelineChangeSet;
  preview: PipelineChangeSetPreview;
}

export interface IntegrateAgentCheckpointsInput {
  workspaceCwd: string;
  runId: string;
  checkpoints: readonly AgentCheckpointResult[];
  signal?: AbortSignal;
}

export interface PromotionRequest {
  changeSet: PipelineChangeSet;
  preview: PipelineChangeSetPreview;
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

/**
 * Gère le cycle Git des changements produits par des agents isolés.
 *
 * Les Agent Checkpoints sont récupérés sans modifier le workspace hôte, puis
 * rejoués sur une ref privée dans l'ordre fourni par le coordinateur du DAG.
 * Une seule décision de Promotion porte ensuite sur le Pipeline Change Set.
 *
 * Voir `docs/adr/0002-promote-one-multi-agent-change-set.md`.
 */
export class GitPromotion {
  constructor(private readonly execute: SubprocessExecutor) {}

  async deleteAgentCheckpoints(
    workspaceCwd: string,
    checkpoints: readonly AgentCheckpointResult[],
  ): Promise<void> {
    for (const result of checkpoints) {
      await this.requireSuccess({
        command: 'git',
        args: ['update-ref', '-d', result.checkpoint.ref],
        cwd: workspaceCwd,
        stdin: 'ignore',
      }, `delete superseded Agent Checkpoint "${result.checkpoint.nodeId}" attempt ${result.checkpoint.attempt}`);
    }
  }

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

  async integrateAgentCheckpoints(input: IntegrateAgentCheckpointsInput): Promise<PipelineChangeSetResult> {
    if (input.checkpoints.length === 0) {
      throw new Error('Cannot integrate an empty Agent Checkpoint collection.');
    }

    const first = input.checkpoints[0].checkpoint;
    const baseCommit = first.baseCommit;
    const integratedNodeIds = input.checkpoints.map(result => result.checkpoint.nodeId);
    for (const result of input.checkpoints) {
      const checkpoint = result.checkpoint;
      if (checkpoint.runId !== input.runId) {
        throw new Error(`Agent Checkpoint for run "${checkpoint.runId}" cannot be integrated into run "${input.runId}".`);
      }
      if (checkpoint.baseCommit !== baseCommit || result.preview.baseCommit !== baseCommit) {
        throw new Error(`Agent Checkpoint "${checkpoint.nodeId}" does not share Pipeline base ${baseCommit}.`);
      }
      if (result.preview.checkpointCommit !== checkpoint.commit) {
        throw new Error(`Agent Checkpoint "${checkpoint.nodeId}" preview does not match commit ${checkpoint.commit}.`);
      }
    }

    const changed = input.checkpoints.filter(result => result.preview.fileCount > 0);
    if (changed.length === 0) {
      return {
        changeSet: {
          runId: input.runId,
          baseCommit,
          commit: baseCommit,
          ref: baseCommit,
          integratedNodeIds,
        },
        preview: {
          baseCommit,
          changeSetCommit: baseCommit,
          fileCount: 0,
          files: [],
          diff: '',
        },
      };
    }

    // Tous les commits techniques réutilisent la date de la base : à entrées et
    // ordre identiques, l'identifiant du Pipeline Change Set reste reproductible.
    const integrationDate = (await this.requireSuccess({
      command: 'git',
      args: ['show', '-s', '--format=%cI', baseCommit],
      cwd: input.workspaceCwd,
      stdin: 'ignore',
      signal: input.signal,
    }, 'read the Pipeline base date')).stdout.trim() || '2000-01-01T00:00:00Z';

    let currentCommit = baseCommit;
    const integratedCheckpoints: AgentCheckpoint[] = [];
    for (const [index, result] of changed.entries()) {
      const checkpoint = result.checkpoint;
      await this.requireSuccess({
        command: 'git',
        args: ['merge-base', '--is-ancestor', baseCommit, checkpoint.ref],
        cwd: input.workspaceCwd,
        stdin: 'ignore',
        signal: input.signal,
      }, `verify Agent Checkpoint "${checkpoint.nodeId}" ancestry`);

      // merge-tree et commit-tree construisent l'historique sur une ref privée ;
      // aucun checkout ni fichier du workspace hôte n'est modifié ici.
      const mergeResult = await this.execute({
        command: 'git',
        args: ['merge-tree', '--write-tree', currentCommit, checkpoint.ref],
        cwd: input.workspaceCwd,
        stdin: 'ignore',
        signal: input.signal,
      });
      if (mergeResult.exitCode !== 0) {
        const files = integrationConflictFiles(mergeResult);
        if (mergeResult.exitCode === 1 || files.length > 0) {
          throw new IntegrationConflictError({
            runId: input.runId,
            baseCommit,
            currentCommit,
            incomingCheckpoint: checkpoint,
            checkpoints: [...integratedCheckpoints, checkpoint],
            files,
          });
        }
        const detail = mergeResult.stderr.trim() || mergeResult.stdout.trim() || `exit code ${mergeResult.exitCode}`;
        throw new Error(`Unable to integrate Agent Checkpoint "${checkpoint.nodeId}": ${detail}`);
      }

      const mergedTree = mergeResult.stdout.trim().split(/\r?\n/u)[0];
      if (!mergedTree) {
        throw new Error(`Unable to integrate Agent Checkpoint "${checkpoint.nodeId}": git merge-tree returned an empty tree id.`);
      }

      currentCommit = (await this.requireSuccess({
        command: 'git',
        args: [
          'commit-tree', mergedTree,
          '-p', currentCommit,
          '-m', 'chore(slopify): integrate Agent Checkpoint',
          '-m', `Slopify-Run: ${input.runId}`,
          '-m', `Slopify-Node: ${checkpoint.nodeId}`,
          '-m', `Slopify-Attempt: ${checkpoint.attempt}`,
          '-m', `Slopify-Integration-Index: ${index}`,
        ],
        cwd: input.workspaceCwd,
        stdin: 'ignore',
        signal: input.signal,
        env: {
          GIT_AUTHOR_NAME: SLOPIFY_GIT_NAME,
          GIT_AUTHOR_EMAIL: SLOPIFY_GIT_EMAIL,
          GIT_AUTHOR_DATE: integrationDate,
          GIT_COMMITTER_NAME: SLOPIFY_GIT_NAME,
          GIT_COMMITTER_EMAIL: SLOPIFY_GIT_EMAIL,
          GIT_COMMITTER_DATE: integrationDate,
        },
      }, `record integrated Agent Checkpoint "${checkpoint.nodeId}"`)).stdout.trim();
      if (!currentCommit) {
        throw new Error(`Unable to record integrated Agent Checkpoint "${checkpoint.nodeId}": git commit-tree returned an empty commit id.`);
      }
      integratedCheckpoints.push(checkpoint);
    }

    const ref = pipelineChangeSetRef(input.runId);
    await this.requireSuccess({
      command: 'git',
      args: ['update-ref', ref, currentCommit],
      cwd: input.workspaceCwd,
      stdin: 'ignore',
      signal: input.signal,
    }, 'publish the private Pipeline Change Set ref');

    const range = `${baseCommit}..${ref}`;
    const filesResult = await this.requireSuccess({
      command: 'git',
      args: ['diff', '--name-only', range],
      cwd: input.workspaceCwd,
      stdin: 'ignore',
      signal: input.signal,
    }, 'list the Pipeline Change Set files');
    const diffResult = await this.requireSuccess({
      command: 'git',
      args: ['diff', '--no-ext-diff', '--no-color', range],
      cwd: input.workspaceCwd,
      stdin: 'ignore',
      signal: input.signal,
    }, 'preview the Pipeline Change Set');
    const files = filesResult.stdout.split(/\r?\n/u).filter(Boolean);

    return {
      changeSet: {
        runId: input.runId,
        baseCommit,
        commit: currentCommit,
        ref,
        integratedNodeIds,
      },
      preview: {
        baseCommit,
        changeSetCommit: currentCommit,
        fileCount: files.length,
        files,
        diff: diffResult.stdout,
      },
    };
  }

  async promotePipelineChangeSet(input: PromotePipelineChangeSetInput): Promise<PromotionResult> {
    const request: PromotionRequest = {
      changeSet: input.changeSet,
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
      args: ['merge-base', '--is-ancestor', input.changeSet.baseCommit, input.changeSet.ref],
      cwd: input.workspaceCwd,
      stdin: 'ignore',
      signal: input.signal,
    }, 'verify the Pipeline Change Set ancestry');

    // La décision peut intervenir longtemps après les Sandbox Runs. La base et
    // la propreté du workspace sont donc revérifiées juste avant le fast-forward,
    // qui constitue l'unique mutation du workspace hôte.
    const status = await this.requireSuccess({
      command: 'git',
      args: ['status', '--porcelain=v1'],
      cwd: input.workspaceCwd,
      stdin: 'ignore',
      signal: input.signal,
    }, 'revalidate the host workspace before Promotion');
    if (status.stdout.trim()) {
      throw new Error('Unable to promote the Pipeline Change Set: the host workspace changed after the sandbox runs. No changes were applied.');
    }

    const currentHead = (await this.requireSuccess({
      command: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd: input.workspaceCwd,
      stdin: 'ignore',
      signal: input.signal,
    }, 'revalidate the host Git base before Promotion')).stdout.trim();
    if (currentHead !== input.changeSet.baseCommit) {
      throw new Error(`Unable to promote the Pipeline Change Set: the host Git base diverged from ${input.changeSet.baseCommit} to ${currentHead || 'an unknown commit'}. No changes were applied.`);
    }

    await this.requireSuccess({
      command: 'git',
      args: ['merge', '--ff-only', '--no-edit', input.changeSet.ref],
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

function integrationConflictFiles(result: SubprocessResult): string[] {
  const files = new Set<string>();
  const output = `${result.stdout}\n${result.stderr}`;
  for (const line of output.split(/\r?\n/u)) {
    const staged = /^\d{6}\s+[0-9a-f]+\s+[123]\t(.+)$/iu.exec(line);
    if (staged?.[1]) {
      files.add(staged[1]);
      continue;
    }
    const conflictIn = /^CONFLICT\b.*?\bin\s+(.+)$/iu.exec(line);
    if (conflictIn?.[1]) {
      files.add(conflictIn[1]);
    }
  }
  return [...files].sort();
}

function pipelineChangeSetRef(runId: string): string {
  const normalized = runId.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'run';
  const hash = createHash('sha256').update(runId).digest('hex').slice(0, 10);
  return `refs/slopify/runs/${normalized.slice(0, 50)}-${hash}/change-set`;
}
