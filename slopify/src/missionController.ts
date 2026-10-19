import type { BatchTaskState, TaskBatchSnapshot } from './taskBatch.js';

/** Exigence de preuve déduite par le contrôleur à partir des critères d'acceptation du ticket. */
export interface ProofRequirement {
  id: string;
  description: string;
}

/** Verdict structuré du reviewer ; une affirmation sans preuve n'est pas un verdict valide. */
export interface ReviewVerdict {
  verdict: 'PASS' | 'FAIL';
  proofs: Record<string, string>;
  findings: string[];
  summary: string;
}

/** Journal compact et durable des décisions du contrôleur. */
export interface DecisionRecord {
  at: string;
  taskId: string;
  action: string;
  reason: string;
  refs?: string[];
}

/** État synthétique transmis au contrôleur : jamais les transcriptions des workers. */
export interface ControllerTaskView {
  taskId: string;
  phase: NonNullable<BatchTaskState['phase']>;
  status: BatchTaskState['status'];
  corrections: number;
  maxCorrections: number;
  proofContract: ProofRequirement[];
  lastReview?: { verdict: 'PASS' | 'FAIL'; findings: string[]; summary: string };
}

/** Décideur à la demande : missions bornées IMPLEMENT, REVIEW, CORRECT, ACCEPT, STOP. */
export interface MissionController {
  /** Définit le contrat de preuves exigé du reviewer avant la mission d'implémentation. */
  planImplementation(view: ControllerTaskView, snapshot: TaskBatchSnapshot): Promise<{ proofs: ProofRequirement[]; reason: string }>;
  /** Décide la suite d'une review FAIL : correction ciblée ou arrêt. */
  decideAfterReviewFailure(view: ControllerTaskView, snapshot: TaskBatchSnapshot): Promise<{ mission: 'CORRECT' | 'STOP'; reason: string }>;
}

/** Contrôleur déterministe par défaut : règles codées, aucun appel LLM. */
export const defaultMissionController: MissionController = {
  async planImplementation(view) {
    return {
      proofs: [
        { id: 'implementation-report', description: `Référence vers le rapport final du ticket ${view.taskId} et ses validations exécutées.` },
      ],
      reason: 'Contrat de preuves déduit des critères du ticket.',
    };
  },
  async decideAfterReviewFailure(view) {
    if (view.corrections >= view.maxCorrections) {
      return { mission: 'STOP', reason: `Plafond de ${view.maxCorrections} corrections atteint pour ${view.taskId}.` };
    }
    return { mission: 'CORRECT', reason: 'Review FAIL : correction ciblée des findings.' };
  },
};

export const REVIEW_MARKER = 'SLOPIFY_RESULT_REVIEW=';

/** Extrait et valide le verdict SLOPIFY_RESULT_REVIEW du message final du reviewer.
 * Un verdict absent ou invalide échoue la review : un exit code 0 ne suffit pas. */
export function parseReviewVerdict(finalMessage: string): ReviewVerdict {
  const lines = finalMessage.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith(REVIEW_MARKER));
  if (lines.length !== 1) {
    return { verdict: 'FAIL', proofs: {}, findings: ['Review verdict missing or invalid: expected exactly one SLOPIFY_RESULT_REVIEW line.'], summary: 'Verdict absent.' };
  }
  let outcome: unknown;
  try { outcome = JSON.parse(lines[0].slice(REVIEW_MARKER.length)); }
  catch { return invalid('SLOPIFY_RESULT_REVIEW must contain valid JSON.'); }
  if (outcome === null || typeof outcome !== 'object' || Array.isArray(outcome)) return invalid('SLOPIFY_RESULT_REVIEW must be an object.');
  const record = outcome as Record<string, unknown>;
  if (record.verdict !== 'PASS' && record.verdict !== 'FAIL') return invalid('SLOPIFY_RESULT_REVIEW verdict must be PASS or FAIL.');
  const proofs: Record<string, string> = {};
  if (record.proofs !== undefined) {
    if (record.proofs === null || typeof record.proofs !== 'object' || Array.isArray(record.proofs)) return invalid('SLOPIFY_RESULT_REVIEW proofs must be an object.');
    for (const [key, value] of Object.entries(record.proofs as Record<string, unknown>)) {
      if (typeof value !== 'string' || value.trim().length === 0) return invalid(`SLOPIFY_RESULT_REVIEW proof "${key}" must be a nonempty string.`);
      proofs[key] = value;
    }
  }
  const findings = Array.isArray(record.findings)
    ? record.findings.map(value => String(value)).filter(value => value.length > 0)
    : [];
  const summary = typeof record.summary === 'string' ? record.summary : '';
  if (record.verdict === 'PASS' && findings.length > 0) return invalid('A PASS verdict must not carry findings.');
  return { verdict: record.verdict, proofs, findings, summary };
}

function invalid(message: string): ReviewVerdict {
  return { verdict: 'FAIL', proofs: {}, findings: [`Review verdict invalid: ${message}`], summary: 'Verdict invalide.' };
}

/** Vérifie la présence et la cohérence des preuves exigées ; une preuve manquante échoue la validation. */
export function missingProofs(contract: ProofRequirement[], proofs: Record<string, string>): string[] {
  return contract
    .filter(requirement => typeof proofs[requirement.id] !== 'string' || proofs[requirement.id].trim().length === 0)
    .map(requirement => `Required proof "${requirement.id}" is missing: ${requirement.description}`);
}
