import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { AgentNodeSessionActivity, PipelineProgress } from './PipelineV3Types';

export const PROGRESS_INSTRUCTIONS = `Publish a short progress update at each meaningful change of work, as a standalone line in a public agent message:
<slopify_progress>{"action":"Implement expiration check","target":"TokenValidator.ts","result":"","next":"Run focused tests"}</slopify_progress>
Use only these four string fields (maximum 240 characters each). Describe work, not private reasoning. Do not copy file contents, environment values, secrets or command arguments. Report actual results only after observing them. Keep progress separate from the final output artifact; preserve its required format.`;

export function stripProgress(text: string): string {
  return text.replace(/<slopify_progress>[\s\S]*?<\/slopify_progress>/g, '').trim();
}

export function validProgress(value: unknown): value is PipelineProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Object.keys(entry).every(key => ['action', 'target', 'result', 'next', 'source', 'observation'].includes(key))
    && ['action', 'target', 'result', 'next'].every(key => typeof entry[key] === 'string'
      && (entry[key] as string).length <= 240 && !/[\x00-\x1f\x7f]/.test(entry[key] as string))
    && (entry.action as string).trim().length > 0
    && ['agent', 'runtime'].includes(entry.source as string)
    && (entry.observation === undefined || (typeof entry.observation === 'string' && entry.observation.length <= 240 && !/[\x00-\x1f\x7f]/.test(entry.observation)));
}

/** Bounded streaming decoder; thought chunks and tool arguments are never parsed. */
export class PipelineProgressDecoder {
  private buffer = '';
  private last = '';
  private intent?: PipelineProgress;
  constructor(private readonly publish: (activity: AgentNodeSessionActivity) => void) {}

  accept(notification: SessionNotification): void {
    const update = notification.update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      this.buffer += update.content.text;
      const open = '<slopify_progress>';
      const close = '</slopify_progress>';
      while (true) {
        const start = this.buffer.indexOf(open);
        if (start < 0) { this.buffer = this.buffer.slice(-(open.length - 1)); break; }
        const end = this.buffer.indexOf(close, start + open.length);
        if (end < 0) {
          this.buffer = this.buffer.slice(start);
          if (this.buffer.length > 2048) this.buffer = '';
          break;
        }
        const body = this.buffer.slice(start + open.length, end);
        this.buffer = this.buffer.slice(end + close.length);
        if (body.length > 2048) continue;
        try {
          const parsed: unknown = JSON.parse(body);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const progress = { ...parsed, source: 'agent' };
            if (Object.keys(parsed).every(key => ['action', 'target', 'result', 'next'].includes(key)) && validProgress(progress)) {
              this.intent = progress;
              this.emit(progress);
            }
          }
        } catch { /* Invalid statuses never fail the agent or fabricate intent. */ }
      }
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const kind = update.kind ?? 'other';
      const verbs: Record<string, string> = { read: 'Lecture', edit: 'Modification', delete: 'Suppression', execute: 'Exécution', search: 'Recherche', fetch: 'Récupération', other: 'Appel outil' };
      const action = verbs[kind] ?? 'Appel outil';
      const result = update.status === 'completed' ? 'Outil terminé' : update.status === 'failed' ? 'Outil en échec' : '';
      this.emit(this.intent ? { ...this.intent, observation: [action, result].filter(Boolean).join(' : ') }
        : { action, target: '', result, next: '', source: 'runtime' });
    }
  }

  private emit(progress: PipelineProgress): void {
    const key = JSON.stringify(progress);
    if (this.last === key) return;
    this.last = key;
    this.publish({ kind: 'status', content: progress.action, progress });
  }
}
