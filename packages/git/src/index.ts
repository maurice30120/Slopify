import type { SubprocessExecutor, SubprocessRequest } from '@slopify/execution';

export const SLOPIFY_GIT_NAME = 'Slopify';
export const SLOPIFY_GIT_EMAIL = 'slopify@localhost';

/** Checkpoint durable produit depuis le clone privé d'une tentative. */
export interface AgentCheckpoint {
  runId: string;
  taskId: string;
  attemptId: string;
  sandboxName: string;
  baseCommit: string;
  commit: string;
  ref: string;
}

/** Résultat de la création d'un checkpoint : le checkpoint et son aperçu de fichiers et diff. */
export interface AgentCheckpointResult {
  checkpointStatus: 'checkpointed' | 'no_changes';
  checkpoint: AgentCheckpoint;
  preview: { baseCommit: string; checkpointCommit: string; fileCount: number; files: string[]; diff: string };
}

export interface CreateAgentCheckpointInput {
  /** Répertoire de travail Git à figer : le clone privé de la tentative. */
  workspaceCwd: string;
  sandboxName: string;
  baseCommit: string;
  runId: string;
  taskId: string;
  attemptId: string;
  signal?: AbortSignal;
}

export interface GitOperationsOptions {
  /**
   * Environnement d'exécution des commandes Git : chaque commande passe par ce seam,
   * qu'il s'agisse du sous-processus hôte, d'un pool de Workers ou d'une sandbox.
   * Le transport (cwd, préfixe d'invocation) reste fourni par l'environnement d'exécution.
   */
  executor: SubprocessExecutor;
  /** Commandes Git propres au transport : une sandbox préfixe `sbx exec <name> git ...`. */
  gitCommand?: (args: string[], input: { workspaceCwd?: string; signal?: AbortSignal }) => SubprocessRequest;
}

/**
 * Opérations Git V2 : création du checkpoint d'agent depuis un clone privé,
 * publication sur une ref privée, aperçu de fichiers et diff. Le workspace hôte
 * et ses branches publiques ne sont jamais touchés.
 */
export class GitOperations {
  constructor(private readonly options: GitOperationsOptions) {}

  private request(args: string[], input: { workspaceCwd?: string; signal?: AbortSignal }): SubprocessRequest {
    return this.options.gitCommand
      ? this.options.gitCommand(args, input)
      : { command: 'git', args, cwd: input.workspaceCwd ?? process.cwd(), stdin: 'ignore', signal: input.signal };
  }

  private async requireSuccess(request: SubprocessRequest, action: string): Promise<{ stdout: string }> {
    const result = await this.options.executor(request);
    if (result.exitCode !== 0) {
      throw new Error(`Cannot ${action}: ${result.stderr || result.stdout}`);
    }
    return result;
  }

  /**
   * Fige les changements du clone privé en checkpoint durable et inspectable.
   * Le commit est publié sur une ref privée ; il ne modifie pas le workspace hôte.
   * @throws Error si le commit, la ref ou la lecture du checkpoint échouent.
   */
  async createAgentCheckpoint(input: CreateAgentCheckpointInput): Promise<AgentCheckpointResult> {
    const git = (args: string[]) => this.request(args, input);
    await this.requireSuccess(git(['add', '--all']), 'stage the Agent Checkpoint');
    await this.requireSuccess(git([
      '-c', `user.name=${SLOPIFY_GIT_NAME}`,
      '-c', `user.email=${SLOPIFY_GIT_EMAIL}`,
      '-c', 'commit.gpgsign=false',
      'commit', '--allow-empty', '--no-verify',
      '-m', 'chore(slopify): create Agent Checkpoint',
      '-m', `Slopify-Run: ${input.runId}`,
      '-m', `Slopify-Task: ${input.taskId}`,
      '-m', `Slopify-Attempt: ${input.attemptId}`,
    ]), 'create the Agent Checkpoint');
    const ref = `refs/slopify/checkpoints/${input.sandboxName}`;
    await this.requireSuccess(git(['update-ref', ref, 'HEAD']), 'publish the Agent Checkpoint');
    const checkpointCommit = (await this.requireSuccess(git(['rev-parse', 'HEAD']), 'read the Agent Checkpoint commit')).stdout.trim();
    if (!checkpointCommit) {
      throw new Error('Unable to read the Agent Checkpoint commit: git returned an empty commit id.');
    }
    const range = `${input.baseCommit}..${ref}`;
    const filesResult = await this.requireSuccess(git(['diff', '--name-only', range]), 'list the Agent Checkpoint files');
    const diffResult = await this.requireSuccess(git(['diff', '--no-ext-diff', '--no-color', range]), 'preview the Agent Checkpoint');
    const files = filesResult.stdout.split(/\r?\n/u).filter(Boolean);
    const checkpoint: AgentCheckpoint = {
      runId: input.runId, taskId: input.taskId, attemptId: input.attemptId,
      sandboxName: input.sandboxName, baseCommit: input.baseCommit, commit: checkpointCommit, ref,
    };
    return {
      checkpointStatus: files.length === 0 ? 'no_changes' : 'checkpointed',
      checkpoint,
      preview: {
        baseCommit: input.baseCommit, checkpointCommit, fileCount: files.length, files,
        diff: diffResult.stdout,
      },
    };
  }
}
