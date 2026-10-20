import type { SubprocessExecutor, SubprocessRequest } from '@slopify/execution';

export const MINIMUM_SBX_VERSION = '0.35.0';

/** Vérifications sbx utiles à la V2, extraites de l'ancien runtime ACP : dépôt Git,
 * version minimale de sbx et capacités requises. Aucun autre comportement du runtime
 * historique n'est conservé. */
export class SbxPreflight {
  constructor(private readonly executor: SubprocessExecutor) {}

  private async requireSuccess(request: SubprocessRequest, action: string): Promise<{ stdout: string; stderr: string }> {
    const result = await this.executor(request);
    if (result.exitCode !== 0) {
      throw new Error(`Cannot ${action}: ${result.stderr || result.stdout}`);
    }
    return result;
  }

  private async requireCapability(cwd: string, args: string[], capability: string, signal?: AbortSignal): Promise<void> {
    const result = await this.requireSuccess({ command: 'sbx', args, cwd, stdin: 'ignore', signal }, `verify Docker Sandbox capability ${capability}`);
    if (!`${result.stdout}\n${result.stderr}`.includes(capability)) {
      throw new Error(`Installed sbx does not provide the required ${capability} capability. Upgrade Docker Sandboxes (sbx) and retry.`);
    }
  }

  async preflightWorkspace(input: { cwd: string; signal?: AbortSignal }): Promise<void> {
    const { cwd, signal } = input;
    await this.requireSuccess({ command: 'git', args: ['rev-parse', '--is-inside-work-tree'], cwd, stdin: 'ignore', signal }, 'verify that the workspace is a Git repository');
    const version = await this.requireSuccess({ command: 'sbx', args: ['version'], cwd, stdin: 'ignore', signal }, 'read the Docker Sandbox version');
    const actual = version.stdout.match(/\bv?(\d+\.\d+\.\d+)\b/i)?.[1];
    if (!actual || compareVersions(actual, MINIMUM_SBX_VERSION) < 0) {
      throw new Error(`Docker Sandbox sbx ${MINIMUM_SBX_VERSION} or newer is required (found ${actual ?? 'an unknown version'}). Upgrade Docker Sandboxes (sbx) and retry.`);
    }
    await this.requireCapability(cwd, ['create', '--help'], '--clone', signal);
    await this.requireCapability(cwd, ['ls', '--help'], '--json', signal);
  }
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}
