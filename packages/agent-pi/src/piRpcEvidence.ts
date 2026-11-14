import { appendFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Rédaction des secrets avant toute persistance de preuve : les journaux durables
 * du workflow RPC ne doivent jamais contenir d'identifiants fournisseur, même si
 * un événement Pi ou un rapport les citait par accident.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s"';,]+/gi,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g,
  /\b((?:api[_-]?key|secret|token|password)\s*["']?\s*[:=]\s*["']?)[^\s"',;]+/gi,
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
  /\b([A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*\s*=\s*)[^\s"',;]+/g,
];

/** Remplace chaque fragment sensible par [redacted] ; le reste du texte est préservé. */
export function redactSecrets(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, ...groups) => {
      const prefix = groups[0];
      return typeof prefix === 'string' ? `${prefix}[redacted]` : '[redacted]';
    });
  }
  return redacted;
}

/** Phase métier agrégée d'une session du workflow Pi RPC, indépendante du protocole de transport. */
export type PiWorkflowPhase =
  | 'session_started'
  | 'implementation_started'
  | 'implementation_settled'
  | 'review_started'
  | 'review_settled'
  | 'review_verdict'
  | 'correction_requested'
  | 'correction_settled'
  | 'workflow_succeeded'
  | 'workflow_failed'
  | 'workflow_blocked'
  | 'workflow_cancelled'
  | 'session_crashed'
  | 'session_stopped';

/** Événement durable du workflow : identifiants corrélés, numéro de séquence stable, détail rédigé sans secret. */
export interface PiWorkflowEvent {
  seq: number;
  runId: string;
  taskId: string;
  attemptId: string;
  role: 'implementer' | 'reviewer';
  sessionId: string;
  phase: PiWorkflowPhase;
  cycle: number;
  timestamp: string;
  /** Court résumé rédigé, jamais les messages internes bruts. */
  detail?: string;
  /** Chemin vers la preuve durable complète. */
  evidencePath?: string;
}

/** Événement de cycle de vie d'une session, journalisé tel quel (rédigé) dans sessions.jsonl. */
export interface PiSessionJournalRecord {
  timestamp: string;
  role: 'implementer' | 'reviewer';
  sessionId: string;
  event: 'started' | 'prompt' | 'settled' | 'exit' | 'stopped';
  cycle?: number;
  promptChars?: number;
  exitCode?: number;
  /** Description du processus (commande, pid), rédigée. */
  description?: string;
  detail?: string;
}

/** Rapport d'un passage de revue, preuve durable persistée dans reviews.jsonl. */
export interface PiReviewJournalRecord {
  timestamp: string;
  cycle: number;
  sessionId: string;
  verdict: 'approved' | 'rejected';
  reason?: string;
  standards?: string;
  spec?: string;
}

/**
 * Preuves durables du workflow RPC d'une tentative : journal de sessions, rapports
 * de revue et événements agrégés numérotés, tous rédigés avant persistance. Chaque
 * tentative possède son répertoire ; la reprise repart de ces preuves sans doublon.
 */
export class PiRpcEvidence {
  readonly directory: string;
  readonly sessionsPath: string;
  readonly reviewsPath: string;
  readonly eventsPath: string;
  private readonly runId: string;
  private readonly taskId: string;
  private readonly attemptId: string;
  private readonly onEvent?: (event: PiWorkflowEvent) => void;
  private readonly now: () => string;
  private seq = 0;
  private ready?: Promise<void>;

  constructor(options: {
    runId: string; taskId: string; attemptId: string; resultDirectory: string;
    onEvent?: (event: PiWorkflowEvent) => void; now?: () => string;
  }) {
    this.runId = options.runId;
    this.taskId = options.taskId;
    this.attemptId = options.attemptId;
    this.directory = path.join(options.resultDirectory, 'pi-rpc');
    this.sessionsPath = path.join(this.directory, 'sessions.jsonl');
    this.reviewsPath = path.join(this.directory, 'reviews.jsonl');
    this.eventsPath = path.join(this.directory, 'workflow-events.jsonl');
    this.onEvent = options.onEvent;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Crée le répertoire des preuves une seule fois, en série pour éviter les écritures concurrentes. */
  private ensure(): Promise<void> {
    this.ready ??= mkdir(this.directory, { recursive: true, mode: 0o700 }).then(() => undefined);
    return this.ready;
  }

  private async append(file: string, record: unknown): Promise<void> {
    await this.ensure();
    await appendFile(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  }

  /** Journalise un événement de cycle de vie de session (rédigé). */
  async session(record: PiSessionJournalRecord): Promise<void> {
    await this.append(this.sessionsPath, redactJson(record));
  }

  /** Journalise le rapport d'un passage de revue (rédigé). */
  async review(record: PiReviewJournalRecord): Promise<void> {
    await this.append(this.reviewsPath, redactJson(record));
  }

  /** Émet un événement agrégé : séquence stable, persistance durable, puis remontée hôte facultative. */
  async event(phase: PiWorkflowPhase, options: {
    role: 'implementer' | 'reviewer'; sessionId: string; cycle: number;
    detail?: string; evidencePath?: string;
  }): Promise<PiWorkflowEvent> {
    this.seq += 1;
    const event: PiWorkflowEvent = {
      seq: this.seq, runId: this.runId, taskId: this.taskId, attemptId: this.attemptId,
      role: options.role, sessionId: options.sessionId, phase, cycle: options.cycle,
      timestamp: this.now(),
      ...(options.detail !== undefined ? { detail: redactSecrets(options.detail).slice(0, 2000) } : {}),
      ...(options.evidencePath !== undefined ? { evidencePath: options.evidencePath } : {}),
    };
    await this.append(this.eventsPath, event);
    try { this.onEvent?.(event); }
    catch { /* Une remontée hôte défaillante ne doit jamais interrompre le workflow. */ }
    return event;
  }
}

/** Rédige récursivement chaque chaîne d'une valeur JSON avant persistance. */
function redactJson<T>(value: T): T {
  return JSON.parse(redactSecrets(JSON.stringify(value))) as T;
}
