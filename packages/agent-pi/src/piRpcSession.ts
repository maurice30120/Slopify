import { randomUUID } from 'node:crypto';
import type { TaskDiagnostic } from '@slopify/execution';
import { redactSecrets } from './piRpcEvidence.js';

/**
 * Contrat RPC minimal de Pi (protocole JSONL strict, docs rpc.md de Pi) : une
 * commande `{"id","type":"prompt","message"}` reçoit une `response`, puis un flux
 * d'événements (`message_update`, `tool_execution_*`, `message_end`, `agent_end`)
 * terminé par `agent_settled`. La fermeture du stdin est l'arrêt ordonné.
 */
export interface PiRpcChannel {
  /** Écrit une ligne JSONL (commande RPC) sur le stdin du processus. */
  writeLine(line: string): void;
  /** Arrêt ordonné du processus et de ses descendants ; résout au code de sortie observé. */
  close(): Promise<{ exitCode: number; stderrTail: string }>;
  /** Le processus n'a pas encore été observé terminé. */
  readonly alive: boolean;
  /** Description durable du processus (commande, pid) pour le journal de session. */
  describe(): string;
}

/** Le mode d'exécution (sandbox ou local) fournit le processus ; la session possède le protocole. */
export type PiRpcChannelFactory = (session: {
  role: PiRpcSessionRole;
  onRecord: (line: string) => void;
  onStderr: (chunk: string) => void;
  onExit: (exit: { exitCode: number; stderrTail: string }) => void;
}) => PiRpcChannel;

export type PiRpcSessionRole = 'implementer' | 'reviewer';

/** Sous-agent délégué observé pendant un tour (revue Standards ou Spec). */
export interface PiRpcSubagentObservation {
  agent: string;
  exitCode: number;
  text: string;
  error?: string;
}

/** Résultat terminal observable d'un tour de conversation RPC. */
export interface PiRpcTurn {
  /** Vrai quand `agent_settled` a été observé avant la mort du processus. */
  settled: boolean;
  /** Dernier message assistant complet du tour. */
  finalText: string;
  /** Rapports observés : messages assistants et délégations de sous-agents, preuve de la conversation. */
  reports: string[];
  /** Résultats bruts des délégations subagent, preuve durable. */
  reviews: unknown[];
  /** Sous-agents observés, structurés par nom d'agent. */
  subagents: PiRpcSubagentObservation[];
  diagnostics: TaskDiagnostic[];
}

interface TurnState {
  settled: boolean;
  finalText: string;
  reports: string[];
  reviews: unknown[];
  subagents: PiRpcSubagentObservation[];
  diagnostics: TaskDiagnostic[];
}

/**
 * Une session RPC Pi vivante : identifiée de façon stable, elle traite les
 * enregistrements dans l'ordre d'émission et termine un tour sur `agent_settled`
 * ou sur la mort du processus. Le protocole n'est jamais réinitialisé : un
 * nouveau message envoyé à la même session poursuit la même conversation.
 */
export class PiRpcSession {
  readonly sessionId: string;
  readonly role: PiRpcSessionRole;
  private readonly channel: PiRpcChannel;
  private turn: TurnState | undefined;
  private promptId: string | undefined;
  private exit: { exitCode: number; stderrTail: string } | undefined;
  private abortWaiter: (() => void) | undefined;
  private readonly pending: Array<() => void> = [];

  constructor(options: { role: PiRpcSessionRole; sessionId?: string; openChannel: PiRpcChannelFactory }) {
    this.role = options.role;
    this.sessionId = options.sessionId ?? randomUUID();
    this.channel = options.openChannel({
      role: this.role,
      onRecord: line => this.ingest(line),
      onStderr: () => { /* Les flux bruts sont journalisés par l'environnement d'exécution. */ },
      onExit: exit => { this.exit = exit; const waiter = this.abortWaiter; this.abortWaiter = undefined; waiter?.(); this.flush(); },
    });
  }

  /** Le processus n'a pas encore été observé terminé. */
  get alive(): boolean { return this.channel.alive; }

  /** Mort observée du processus, si elle s'est produite ; distingue un crash d'un tour réglé. */
  get exited(): { exitCode: number; stderrTail: string } | undefined { return this.exit; }

  /** Description durable du processus sous-jacent, pour le journal de session. */
  describe(): string { return this.channel.describe(); }

  /**
   * Envoie un message à la session et attend le résultat terminal du tour
   * (`agent_settled` ou mort du processus). Dans une session vivante, le message
   * poursuit la conversation existante ; aucun contexte n'est recréé.
   */
  async prompt(message: string): Promise<PiRpcTurn> {
    if (this.exit) throw new Error(`Pi RPC session ${this.sessionId} (${this.role}) is already stopped.`);
    this.turn = { settled: false, finalText: '', reports: [], reviews: [], subagents: [], diagnostics: [] };
    this.promptId = `prompt-${randomUUID()}`;
    this.channel.writeLine(JSON.stringify({ id: this.promptId, type: 'prompt', message }));
    await this.settle();
    const turn = this.turn;
    this.turn = undefined;
    this.promptId = undefined;
    return turn;
  }

  /** Arrêt ordonné : fermeture du stdin, attente de la fin réelle, escalade par le transport. */
  async stop(): Promise<{ exitCode: number; stderrTail: string }> {
    const closed = await this.channel.close();
    if (!this.exit) this.exit = closed;
    this.flush();
    return closed;
  }

  /**
   * Annulation contrôlée : commande RPC `abort`, qui interrompt l'opération en cours
   * et attend le retour au repos avant de répondre. La conversation de la session
   * vivante est conservée : un message ultérieur poursuit le même contexte. La réponse
   * est attendue brièvement : l'arrêt ordonné du canal reste l'autorité finale.
   * Si la mort du processus est déjà observée, aucune commande n'est écrite et
   * la réponse est immédiate (pas d'attente du timeout).
   */
  async abort(): Promise<void> {
    if (this.exit || !this.channel.alive) return;
    this.channel.writeLine(JSON.stringify({ id: `abort-${randomUUID()}`, type: 'abort' }));
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.abortWaiter = undefined; resolve(); }, 1000);
      this.abortWaiter = () => { clearTimeout(timer); resolve(); };
    });
  }

  private settle(): Promise<void> {
    return new Promise(resolve => { this.pending.push(resolve); this.flush(); });
  }

  private flush(): void {
    if (!this.pending.length) return;
    if (this.turn?.settled || this.exit) {
      const waiters = this.pending.splice(0);
      for (const waiter of waiters) waiter();
    }
  }

  private ingest(line: string): void {
    let recordValue: Record<string, unknown> | undefined;
    try { recordValue = record(JSON.parse(line)); } catch { return; }
    if (!recordValue || !this.turn) return;
    const event = recordValue;
    const turn = this.turn;
    if (event.type === 'response') {
      if (event.command === 'prompt' && event.id === this.promptId && event.success !== true) {
        turn.diagnostics.push({ code: 'pi_rpc_command_error', message: redactSecrets(line).slice(0, 2000) });
        if (event.command === 'prompt') {
          turn.settled = true;
          this.flush();
        }
      }
      // Un prompt « handled » a été consommé sans lancer de run : aucun agent_settled ne suivra.
      if (event.command === 'prompt' && event.id === this.promptId && record(event.data)?.disposition === 'handled') {
        turn.settled = true;
        this.flush();
      }
      if (event.command === 'abort') {
        const waiter = this.abortWaiter;
        this.abortWaiter = undefined;
        waiter?.();
      }
    }
    const completedMessages = event.type === 'message_end' ? [event.message]
      : event.type === 'agent_end' && Array.isArray(event.messages) ? event.messages : [];
    for (const value of completedMessages) {
      const text = assistantText(value);
      if (text) { turn.reports.push(text); turn.finalText = text; }
      const message = record(value);
      if (message?.stopReason === 'error' || message?.stopReason === 'aborted' || message?.errorMessage) {
        const error = String(message.errorMessage || message.stopReason);
        turn.diagnostics.push({ code: 'pi_provider_error', message: redactSecrets(error).slice(0, 2000) });
        turn.reports.push(`Observed Pi provider error: ${redactSecrets(error)}`);
      }
    }
    if (event.type === 'tool_execution_end' && event.toolName === 'subagent') {
      turn.reviews.push({ isError: event.isError, result: event.result });
      if (event.isError === true) turn.diagnostics.push({ code: 'pi_subagent_error', message: 'Pi subagent tool failed.' });
      const toolResult = record(event.result);
      const details = record(toolResult?.details);
      const children = Array.isArray(details?.results) ? details.results : [];
      for (const value of children) {
        const child = record(value);
        if (!child) continue;
        const name = typeof child.agent === 'string' ? child.agent : 'unknown';
        const error = child.errorMessage || child.stderr || child.stopReason || 'unknown child failure';
        const failed = child.exitCode !== 0 || child.stopReason === 'error' || child.stopReason === 'aborted' || Boolean(child.errorMessage);
        if (failed) turn.diagnostics.push({ code: 'pi_subagent_error', message: `${name}: ${redactSecrets(String(error)).slice(0, 2000)} (observed exit ${String(child.exitCode)})` });
        const messages = Array.isArray(child.messages) ? child.messages : [];
        const text = messages.map(assistantText).filter(Boolean).join('\n\n');
        turn.subagents.push({ agent: name, exitCode: Number(child.exitCode ?? 1), text: redactSecrets(text), ...(failed ? { error: redactSecrets(String(error)) } : {}) });
        turn.reports.push(`## Observed Pi subagent: ${name}\nExit code: ${String(child.exitCode)}\n${text || String(error)}`);
      }
    }
    if (event.type === 'agent_settled') { turn.settled = true; this.flush(); }
  }
}

/** Garde record : un objet JSON simple, jamais un tableau ni une valeur primitive. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Texte assistant d'un message Pi : seuls les blocs texte, jamais la chaîne de pensée. */
function assistantText(value: unknown): string {
  const message = record(value);
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return '';
  return message.content.map(item => {
    const block = record(item);
    return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
  }).filter(Boolean).join('\n');
}
