import type { SubprocessExecutor, SubprocessRequest, SubprocessResult } from '@slopify/execution';

import type { DockerRunSuspension } from '@slopify/execution';
export type { DockerRunSuspension } from '@slopify/execution';

/** A run owns cancellation and the health decision; failed agent outcomes alone never enter this boundary. */
export class DockerRunHealth {
  readonly controller = new AbortController();
  private probe?: Promise<void>;
  private unavailable = false;
  private readonly propagate = () => this.controller.abort(this.parentSignal?.reason);

  constructor(private readonly subprocess: SubprocessExecutor,
    private readonly onUnavailable: (suspension: DockerRunSuspension) => Promise<void>,
    private readonly parentSignal?: AbortSignal) {
    if (parentSignal?.aborted) this.propagate();
    else parentSignal?.addEventListener('abort', this.propagate, { once: true });
  }

  readonly execute: SubprocessExecutor = async request => {
    let result: SubprocessResult;
    try { result = await this.subprocess(request); }
    catch (error) {
      await this.check(request, { error: String(error) });
      throw error;
    }
    if (result.exitCode !== 0) await this.check(request, { exitCode: result.exitCode });
    return result;
  };

  private async check(request: SubprocessRequest, failure: { exitCode?: number; error?: string }): Promise<void> {
    if (request.command !== 'sbx' || request.signal?.aborted || this.unavailable) return;
    if (!this.probe) {
      this.probe = this.checkHealth(request, failure).finally(() => { this.probe = undefined; });
    }
    await this.probe;
  }

  private async checkHealth(request: SubprocessRequest, failure: { exitCode?: number; error?: string }): Promise<void> {
    let healthCheck: DockerRunSuspension['healthCheck'];
    try {
      // Bypass this wrapper, with an independent deadline: cancellation is not evidence of a Docker outage.
      healthCheck = await this.subprocess({ command: 'sbx', args: ['ls', '--json'], cwd: request.cwd,
        stdin: 'ignore', signal: AbortSignal.timeout(10000) });
    } catch (error) { healthCheck = { stdout: '', stderr: '', error: String(error) }; }
    if (healthCheck.exitCode === 0) return;
    this.unavailable = true;
    const suspension: DockerRunSuspension = { kind: 'docker_unavailable', detectedAt: new Date().toISOString(),
      failedCommand: { command: request.command, args: [...request.args], ...failure }, healthCheck, stops: [] };
    this.controller.abort(new Error('Shared Docker control plane is unavailable.'));
    await this.onUnavailable(suspension);
  }

  close(): void { this.parentSignal?.removeEventListener('abort', this.propagate); }
}
