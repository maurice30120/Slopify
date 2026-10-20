import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';

const gitExec = promisify(execFile);
type GitFailure = Error & { code?: number; stdout?: string; stderr?: string };

export interface RunCheckpointIntegrity {
  status: 'valid' | 'invalid' | 'incomplete';
  checkedAt: string;
  reason?: string;
  commit?: string;
  bundlePath?: string;
}

export interface RunIntegrationInput {
  workspacePath: string;
  integrationBranch: string;
  currentCommit: string;
  taskBaseCommit: string;
  checkpointCommit: string;
  bundlePath: string;
  runBaseCommit: string;
  runId: string;
  taskId: string;
  attemptId: string;
}
export type RunIntegrationResult =
  | { status: 'integrated'; commit: string }
  | { status: 'conflicted'; currentCommit: string; incomingCommit: string; files: string[]; output: string };

/**
 * Host Git operations common to local and Docker execution modes.
 * The scheduler owns task state and conflicts; this package owns Git commands.
 * The integration clone lock is shared with the caller's integrate phase.
 */
export class RunGitOperations {
  private integrationLock: Promise<void> = Promise.resolve();

  withIntegrationLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.integrationLock.then(operation, operation);
    this.integrationLock = next.then(() => undefined, () => undefined);
    return next;
  }

  /** Initialize/resume the run-private integration clone; never touch user's checkout. */
  async prepareIntegration(repositoryPath: string, workspacePath: string,
    integrationBranch: string, baseCommit: string, storedCommit?: string): Promise<string> {
    let workspaceExists = false;
    try { workspaceExists = (await stat(workspacePath)).isDirectory(); }
    catch { /* Create the run-private integration clone below. */ }
    if (!workspaceExists) {
      await gitExec('git', ['clone', '--no-hardlinks', '--quiet', '--', repositoryPath, workspacePath]);
    }
    const branchResult = await gitExec('git', ['-C', workspacePath, 'branch', '--list', integrationBranch]);
    const current = branchResult.stdout.trim()
      ? (await gitExec('git', ['-C', workspacePath, 'rev-parse', integrationBranch])).stdout.trim()
      : storedCommit ?? baseCommit;
    await gitExec('git', ['-C', workspacePath, 'checkout', '--detach', current]);
    if (!branchResult.stdout.trim()) {
      await gitExec('git', ['-C', workspacePath, 'branch', integrationBranch, current]);
    }
    return current;
  }

  async clonePinned(integrationPath: string, workspacePath: string, baseCommit: string): Promise<void> {
    await this.withIntegrationLock(async () => {
      await gitExec('git', ['clone', '--no-hardlinks', '--quiet', '--', integrationPath, workspacePath]);
      await gitExec('git', ['-C', workspacePath, 'checkout', '--detach', baseCommit]);
    });
  }

  async validateCheckpoint(input: { workspacePath: string; commit?: string; bundlePath?: string; taskBaseCommit: string }): Promise<RunCheckpointIntegrity> {
    const checkedAt = new Date().toISOString();
    const metadata: Pick<RunCheckpointIntegrity, 'commit' | 'bundlePath'> = {};
    if (input.commit && /^[0-9a-f]{40,64}$/u.test(input.commit)) metadata.commit = input.commit;
    if (input.bundlePath && !input.bundlePath.startsWith('-')) metadata.bundlePath = input.bundlePath;
    if (!metadata.commit) return { status: 'invalid', checkedAt, reason: 'Checkpoint commit is missing or is not a full Git object ID.' };
    if (!metadata.bundlePath) return { status: 'incomplete', checkedAt, ...metadata, reason: 'Checkpoint bundle path is missing or unsafe.' };
    let info;
    try { info = await stat(metadata.bundlePath); }
    catch (error) { return { status: 'incomplete', checkedAt, ...metadata, reason: `Checkpoint bundle is not readable: ${String(error)}` }; }
    if (!info.isFile() || info.size === 0) return { status: 'incomplete', checkedAt, ...metadata, reason: 'Checkpoint bundle is not a non-empty regular file.' };
    const { commit, bundlePath } = metadata as { commit: string; bundlePath: string };
    const git = async (args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: GitFailure }> => {
      try { return { ok: true, stdout: (await gitExec('git', ['-C', input.workspacePath, ...args])).stdout }; }
      catch (error) { return { ok: false, error: error as GitFailure }; }
    };
    const invalid = (reason: string, error?: GitFailure): RunCheckpointIntegrity =>
      ({ status: 'invalid', checkedAt, ...metadata, reason: error ? `${reason}: ${error.message}` : reason });
    const verify = await git(['bundle', 'verify', bundlePath]);
    if (!verify.ok) return invalid('git bundle verify failed', verify.error);
    const heads = await git(['bundle', 'list-heads', bundlePath]);
    if (!heads.ok) return invalid('git bundle list-heads failed', heads.error);
    const advertised = heads.stdout.split('\n').some(line => line.slice(0, 40).toLowerCase() === commit.toLowerCase());
    if (!advertised) return invalid('Checkpoint commit is not advertised by the bundle.');
    const unpack = await git(['bundle', 'unbundle', bundlePath]);
    if (!unpack.ok) return invalid('git bundle unbundle failed; the pack is unreadable', unpack.error);
    const type = await git(['cat-file', '-t', commit]);
    if (!type.ok) return invalid('Checkpoint object is not readable', type.error);
    if (type.stdout.trim() !== 'commit') return invalid('Checkpoint object is not a commit.');
    const ancestor = await git(['merge-base', '--is-ancestor', input.taskBaseCommit, commit]);
    if (!ancestor.ok) return invalid('Checkpoint does not descend from the task base commit.', ancestor.error);
    return { status: 'valid', checkedAt, ...metadata };
  }

  async integrate(input: RunIntegrationInput): Promise<RunIntegrationResult> {
    const dir = input.workspacePath;
    await gitExec('git', ['-C', dir, 'fetch', '--no-tags', input.bundlePath, input.checkpointCommit]);
    await gitExec('git', ['-C', dir, 'merge-base', '--is-ancestor', input.taskBaseCommit, input.checkpointCommit]);
    const alreadyIntegrated = await gitExec('git', ['-C', dir, 'merge-base', '--is-ancestor', input.checkpointCommit, input.currentCommit])
      .then(() => true, error => { if ((error as GitFailure).code === 1) return false; throw error; });
    let commit = alreadyIntegrated ? input.currentCommit : input.checkpointCommit;
    if (!alreadyIntegrated && input.currentCommit !== input.taskBaseCommit) {
      let output: string;
      try {
        output = (await gitExec('git', ['-C', dir, 'merge-tree', '--write-tree', '--name-only', '-z', input.currentCommit, input.checkpointCommit])).stdout;
      } catch (error) {
        const failure = error as GitFailure;
        if (failure.code !== 1) throw error;
        output = failure.stdout ?? '';
        const files = output.split('\0').slice(1).filter((value, index, values) => value !== '' && !values.slice(0, index).includes(''));
        return { status: 'conflicted', currentCommit: input.currentCommit, incomingCommit: input.checkpointCommit, files, output: output + (failure.stderr ?? '') };
      }
      const tree = output.split('\0')[0].trim();
      if (!/^[0-9a-f]{40,64}$/u.test(tree)) throw new Error('Integration did not return a valid Git tree.');
      const date = (await gitExec('git', ['-C', dir, 'show', '-s', '--format=%cI', input.runBaseCommit])).stdout.trim();
      commit = (await gitExec('git', ['-C', dir, 'commit-tree', tree, '-p', input.currentCommit, '-p', input.checkpointCommit,
        '-m', 'chore(slopify): integrate task checkpoint', '-m', `Slopify-Run: ${input.runId}`, '-m', `Slopify-Task: ${input.taskId}`,
        '-m', `Slopify-Attempt: ${input.attemptId}`], {
        env: { ...process.env, GIT_AUTHOR_NAME: 'Slopify', GIT_AUTHOR_EMAIL: 'slopify@localhost',
          GIT_COMMITTER_NAME: 'Slopify', GIT_COMMITTER_EMAIL: 'slopify@localhost',
          GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      })).stdout.trim();
    }
    await gitExec('git', ['-C', dir, 'update-ref', `refs/heads/${input.integrationBranch}`, commit, input.currentCommit]);
    return { status: 'integrated', commit };
  }

  async publish(repositoryPath: string, integrationPath: string, integrationBranch: string): Promise<void> {
    await gitExec('git', ['-C', repositoryPath, 'fetch', '--no-tags', integrationPath,
      `refs/heads/${integrationBranch}:refs/heads/${integrationBranch}`]);
  }

  async removeCompletedBranch(repositoryPath: string, branch: string, expectedCommit: string | undefined): Promise<void> {
    const ref = `refs/heads/${branch}`;
    let actual: string;
    try { actual = (await gitExec('git', ['-C', repositoryPath, 'rev-parse', '--verify', ref])).stdout.trim(); }
    catch { return; }
    if (!expectedCommit || actual !== expectedCommit) throw new Error('Integration branch differs from the recorded run commit; refusing to delete ' + ref);
    await gitExec('git', ['-C', repositoryPath, 'branch', '-D', branch]);
  }
}
