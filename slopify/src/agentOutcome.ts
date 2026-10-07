import type { TaskBatchDiagnostic } from './taskBatch.js';

/** Un transport CLI réussi ne constitue pas le verdict de validation de l'agent. */
export function agentOutcomeDiagnostics(finalMessage: string): TaskBatchDiagnostic[] {
  const verdicts = finalMessage.split(/\r?\n/).map(line => line.trim())
    .filter(line => line.startsWith('SLOPIFY_RESULT='));
  if (verdicts.length !== 1) {
    return [{ code: 'agent_outcome_missing', message: 'Expected one explicit SLOPIFY_RESULT in the final agent message.' }];
  }
  let outcome: unknown;
  try { outcome = JSON.parse(verdicts[0].slice('SLOPIFY_RESULT='.length)); }
  catch { return [{ code: 'agent_outcome_invalid', message: 'SLOPIFY_RESULT must contain valid JSON.' }]; }
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)
    || !('status' in outcome) || typeof outcome.status !== 'string' || !['succeeded', 'failed'].includes(outcome.status)) {
    return [{ code: 'agent_outcome_invalid', message: 'SLOPIFY_RESULT status must be succeeded or failed.' }];
  }
  if (outcome.status === 'failed') {
    const reason = 'reason' in outcome && typeof outcome.reason === 'string' ? outcome.reason : 'Agent reported unsuccessful validation or review.';
    return [{ code: 'agent_reported_failure', message: reason }];
  }
  return [];
}
