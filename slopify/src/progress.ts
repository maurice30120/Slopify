import type { PipelineRuntimeEvent } from '@acp-client/pipeline';
import type { CliTerminal } from './terminal.js';

/** Coalesces bursts; a heartbeat reports silence, never inferred advancement. */
export class CliProgress {
  private readonly rows = new Map<string, { text: string; lastActivity: number; lastDisplay: number; pending: boolean; active: boolean }>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly terminal: CliTerminal, private readonly now = Date.now) {
    this.timer = setInterval(() => this.flush(), 1000);
    this.timer.unref();
  }
  accept(event: PipelineRuntimeEvent): void {
    if (!event.nodeId) {
      if (['completed', 'failed', 'cancelled', 'paused'].includes(event.type)) this.clear();
      return;
    }
    const key = `${event.runId}:${event.nodeId}`;
    const progress = event.activity?.progress;
    if (event.type !== 'node_started' && event.type !== 'agent_activity' && !['node_completed', 'node_failed'].includes(event.type)) return;
    if (event.type === 'agent_activity' && !progress) return;
    const terminal = event.type === 'node_completed' || event.type === 'node_failed';
    const text = progress
      ? [progress.action, progress.target, progress.result, progress.observation, progress.next ? `Ensuite : ${progress.next}` : ''].filter(Boolean).join(' · ')
      : event.type === 'node_started' ? 'Exécution en cours' : event.type === 'node_completed' ? 'Terminé' : 'Échec';
    const prior = this.rows.get(key);
    const now = this.now();
    this.rows.set(key, { text, lastActivity: now, lastDisplay: prior?.lastDisplay ?? -Infinity, pending: true, active: !terminal });
    if (terminal || !prior || now - prior.lastDisplay >= 1000) this.display(key);
  }
  flush(): void {
    for (const [key, row] of this.rows) {
      if (row.pending && this.now() - row.lastDisplay >= 1000) this.display(key);
      else if (row.active && this.now() - row.lastActivity >= 60_000 && this.now() - row.lastDisplay >= 60_000) {
        if (this.terminal.progress) this.terminal.progress(key, `${row.text} — aucune nouvelle activité depuis ${Math.floor((this.now() - row.lastActivity) / 1000)} s`);
        else this.fallbackHeartbeat(key, row.text);
        row.lastDisplay = this.now();
      }
    }
  }
  private fallbackHeartbeat(key: string, text: string): void { this.terminal.writeError(`[${key}] ${text} — aucune nouvelle activité`); }
  private display(key: string): void {
    const row = this.rows.get(key)!;
    if (this.terminal.progress) this.terminal.progress(key, row.text);
    else this.terminal.writeError(`[${key}] ${row.text}`);
    row.lastDisplay = this.now();
    row.pending = false;
  }
  private clear(): void {
    for (const [key, row] of this.rows) if (row.pending) this.display(key);
    this.rows.clear();
    this.terminal.clearProgress?.();
  }
  close(): void { clearInterval(this.timer); this.clear(); }
}
