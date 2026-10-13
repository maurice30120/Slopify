import { createHash } from 'node:crypto';

import type {
  SubprocessExecutor,
  SubprocessRequest,
  SubprocessResult,
} from './runtime.js';

/** Constante SLOPIFY_GIT_NAME qui fixe un contrat partagé du pipeline. */
export const SLOPIFY_GIT_NAME = 'Slopify';
/** Constante SLOPIFY_GIT_EMAIL qui fixe un contrat partagé du pipeline. */
export const SLOPIFY_GIT_EMAIL = 'slopify@localhost';

/** Constante PROMOTION_POLICIES qui fixe un contrat partagé du pipeline. */
export const PROMOTION_POLICIES = ['discard', 'ask', 'auto-apply', 'auto-reject'] as const;

/** Type métier PromotionPolicy utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type PromotionPolicy = typeof PROMOTION_POLICIES[number];
/** Type métier PromotionDecision utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type PromotionDecision = 'apply' | 'reject' | 'cancel';
/** Type métier PromotionStatus utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type PromotionStatus = 'applied' | 'no_changes' | 'rejected' | 'cancelled';

/** Contrat fonctionnel de AgentCheckpoint dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
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

/** Contrat fonctionnel de AgentCheckpointPreview dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface AgentCheckpointPreview {
  baseCommit: string;
  checkpointCommit: string;
  fileCount: number;
  files: string[];
  diff: string;
}

/** Contrat fonctionnel de AgentCheckpointResult dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface AgentCheckpointResult {
  checkpointStatus: 'checkpointed' | 'no_changes';
  checkpoint: AgentCheckpoint;
  preview: AgentCheckpointPreview;
}

/** Contrat fonctionnel de IntegrationConflict dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface IntegrationConflict {
  runId: string;
  baseCommit: string;
  currentCommit: string;
  incomingCheckpoint: AgentCheckpoint;
  checkpoints: AgentCheckpoint[];
  files: string[];
}

/** Composant IntegrationConflictError qui coordonne une étape observable du cycle de vie du pipeline et en préserve les invariants. */
export class IntegrationConflictError extends Error {
  readonly code = 'integration_conflict';

/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
  constructor(readonly conflict: IntegrationConflict) {
    const checkpoints = conflict.checkpoints
      .map(checkpoint => `${checkpoint.nodeId}#${checkpoint.attempt}`)
      .join(', ');
    const files = conflict.files.length > 0 ? conflict.files.join(', ') : 'unknown files';
    super(
      `Integration Conflict while integrating Agent Checkpoint "${conflict.incomingCheckpoint.nodeId}" `
      + `attempt ${conflict.incomingCheckpoint.attempt}. Checkpoints: ${checkpoints}. Files: ${files}.`,
    );
    this.name = 'IntegrationConflictError';
  }
}

/** Contrat fonctionnel de CreateAgentCheckpointInput dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface CreateAgentCheckpointInput {
  workspaceCwd: string;
  sandboxName: string;
  baseCommit: string;
  runId: string;
  nodeId: string;
  attempt: number;
  signal?: AbortSignal;
}

/** Contrat fonctionnel de PipelineChangeSet dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineChangeSet {
  runId: string;
  baseCommit: string;
  commit: string;
  ref: string;
  integratedNodeIds: string[];
}

/** Contrat fonctionnel de PipelineChangeSetPreview dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineChangeSetPreview {
  baseCommit: string;
  changeSetCommit: string;
  fileCount: number;
  files: string[];
  diff: string;
}

/** Contrat fonctionnel de PipelineChangeSetResult dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineChangeSetResult {
  changeSet: PipelineChangeSet;
  preview: PipelineChangeSetPreview;
}

/** Contrat fonctionnel de IntegrateAgentCheckpointsInput dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface IntegrateAgentCheckpointsInput {
  workspaceCwd: string;
  runId: string;
  checkpoints: readonly AgentCheckpointResult[];
  signal?: AbortSignal;
}

/** Contrat fonctionnel de PromotionRequest dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PromotionRequest {
  changeSet: PipelineChangeSet;
  preview: PipelineChangeSetPreview;
}

/** Type métier PromotionDecider utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type PromotionDecider = (
  request: PromotionRequest,
) => PromotionDecision | Promise<PromotionDecision>;

/** Contrat fonctionnel de PromotePipelineChangeSetInput dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PromotePipelineChangeSetInput extends PromotionRequest {
  workspaceCwd: string;
  policy: PromotionPolicy;
  decide?: PromotionDecider;
  signal?: AbortSignal;
}

/** Contrat fonctionnel de PromotionResult dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
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
/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
  constructor(private readonly execute: SubprocessExecutor) {}

/**
 * Supprime les refs privées des Agent Checkpoints devenus obsolètes après intégration.
 * Le workspace hôte et ses branches publiques ne sont jamais touchés.
 * @param workspaceCwd Workspace dont les refs privées doivent être nettoyées.
 * @param checkpoints Checkpoints dont les refs peuvent être supprimées.
 * @throws Error si Git ne peut pas supprimer une ref.
 */
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

/**
 * Fige les changements d'un Sandbox Run en Agent Checkpoint durable et inspectable.
 * Le checkpoint est publié sur une ref privée ; il ne modifie pas le workspace hôte.
 * @param input Identité du run, de la Tâche d'implémentation et de la sandbox à figer.
 * @returns Le checkpoint et son aperçu de fichiers et de diff.
 * @throws Error si le commit, la ref ou la lecture du checkpoint échoue.
 */
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
      // Un nouveau tour d'entretien peut remplacer le checkpoint frère sur cette
      // ref privée. Le forçage reste limité à cette ref interne, jamais à une branche hôte.
      args: ['fetch', '--no-tags', remote, `+HEAD:${ref}`],
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

/**
 * Rejoue les Agent Checkpoints sur leur base commune pour construire un Pipeline Change Set.
 * Un Integration Conflict suspend l'intégration avec les checkpoints et fichiers concernés.
 * @param input Checkpoints d'un même run partageant la même base de pipeline.
 * @returns Le Pipeline Change Set privé et son aperçu intégrable.
 * @throws Error si les checkpoints sont vides, incohérents ou non fusionnables.
 */
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

/**
 * Applique la politique de Promotion au Pipeline Change Set déjà intégré.
 * Seule cette étape peut avancer le workspace hôte ; `ask` délègue la décision à l'appelant.
 * @param input Change Set, aperçu, politique et décideur éventuel de Promotion.
 * @returns Le statut observable : Promotion, Rejection, Cancellation ou absence de changements.
 * @throws Error si la base Git ou la propreté du workspace ne sont plus valides.
 */
  async promotePipelineChangeSet(input: PromotePipelineChangeSetInput): Promise<PromotionResult> {
    const request: PromotionRequest = {
      changeSet: input.changeSet,
      preview: input.preview,
    };

    if (input.preview.fileCount === 0) {
      return { ...request, status: 'no_changes' };
    }

    if (input.policy === 'ask' || input.policy === 'auto-apply') {
      // Une reprise après le fast-forward ne doit jamais redemander une décision
      // susceptible de contredire l'état déjà appliqué du workspace.
      const initialStatus = await this.requireSuccess({
        command: 'git',
        args: ['status', '--porcelain=v1'],
        cwd: input.workspaceCwd,
        stdin: 'ignore',
        signal: input.signal,
      }, 'revalidate the host workspace before Promotion');
      if (initialStatus.stdout.trim()) {
        throw new Error('Unable to promote the Pipeline Change Set: the host workspace changed after the sandbox runs. No changes were applied.');
      }
      const initialHead = (await this.requireSuccess({
        command: 'git',
        args: ['rev-parse', 'HEAD'],
        cwd: input.workspaceCwd,
        stdin: 'ignore',
        signal: input.signal,
      }, 'revalidate the host Git base before Promotion')).stdout.trim();
      if (initialHead === input.changeSet.commit) {
        return { ...request, status: 'applied' };
      }
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
    if (currentHead === input.changeSet.commit) {
      return { ...request, status: 'applied' };
    }
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

/** Valide ou résout les données de cette étape du cycle de vie ; les entrées invalides restent signalées au point d'appel. */
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private async requireSuccess(request: SubprocessRequest, action: string): Promise<SubprocessResult> {
    const result = await this.execute(request);
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      throw new Error(`Unable to ${action}: ${detail}`);
    }
    return result;
  }
}

/** Point d'entrée integrationConflictFiles du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
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

/** Point d'entrée pipelineChangeSetRef du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function pipelineChangeSetRef(runId: string): string {
  const normalized = runId.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'run';
  const hash = createHash('sha256').update(runId).digest('hex').slice(0, 10);
  return `refs/slopify/runs/${normalized.slice(0, 50)}-${hash}/change-set`;
}
