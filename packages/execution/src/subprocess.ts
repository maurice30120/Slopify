import { spawn } from 'node:child_process';

/** Contrat fonctionnel de SubprocessRequest : une commande à exécuter dans un environnement donné. */
export interface SubprocessRequest {
  command: string;
  args: string[];
  cwd: string;
  stdin: 'ignore' | 'inherit';
  observeOutput?: boolean;
  /** Reçoit chaque fragment brut immédiatement, avant la fin du processus. */
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/** Contrat fonctionnel de SubprocessResult : code de sortie et flux captés de la commande. */
export interface SubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Exécuteur de sous-processus : la primitive V2 partagée par tous les environnements d'exécution. */
export type SubprocessExecutor = (request: SubprocessRequest) => Promise<SubprocessResult>;

/**
 * Exécuteur Node natif : environnement conservé, flux stdout/stderr immédiats via onOutput,
 * codes de sortie réels, interruption propagée par AbortSignal.
 */
export function createNodeSubprocessExecutor(): SubprocessExecutor {
  return request => new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      stdio: [request.stdin, 'pipe', 'pipe'],
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
    child.stdout.on('data', chunk => { stdout += chunk; request.onOutput?.('stdout', chunk); if (request.observeOutput) process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { stderr += chunk; request.onOutput?.('stderr', chunk); if (request.observeOutput) process.stderr.write(chunk); });
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
