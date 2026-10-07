import {
  extractClarificationQuestion,
  extractRecommendedAnswer,
  extractSingleProposedPlan,
  getProposedPlanInterviewState,
} from "./ProposedPlan";
import type { PipelineInterviewTurn } from "./PipelineV3Types";

/** Type métier PipelineInterviewProtocolState utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type PipelineInterviewProtocolState =
  | { state: "question"; question: string; recommendedAnswer?: string; content: string }
  | { state: "ready"; artifact: unknown; content: string };

/** Contrat fonctionnel de PipelineInterviewProtocol dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PipelineInterviewProtocol {
  id: string;
/** Valide ou résout les données de cette étape du cycle de vie ; les entrées invalides restent signalées au point d'appel. */
  parseAgentOutput(text: string): PipelineInterviewProtocolState;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  renderReplay(context: {
    originalPrompt: string;
    turns: PipelineInterviewTurn[];
    completionRequested: boolean;
  }): string;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  renderRepair(context: {
    prompt: string;
    diagnostic: string;
  }): string;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  renderFinalOutputRequest(context: {
    prompt: string;
    diagnostic: string;
  }): string;
}

/** Constante PROPOSED_PLAN_PROTOCOL_ID qui fixe un contrat partagé du pipeline. */
export const PROPOSED_PLAN_PROTOCOL_ID = "proposed-plan";

/** Point d'entrée getPipelineInterviewProtocol du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
export function getPipelineInterviewProtocol(id: string): PipelineInterviewProtocol | undefined {
  return id === PROPOSED_PLAN_PROTOCOL_ID ? proposedPlanProtocol : undefined;
}

/** Point d'entrée listPipelineInterviewProtocolIds du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
export function listPipelineInterviewProtocolIds(): string[] {
  return [PROPOSED_PLAN_PROTOCOL_ID];
}

const proposedPlanProtocol: PipelineInterviewProtocol = {
  id: PROPOSED_PLAN_PROTOCOL_ID,

/** Valide ou résout les données de cette étape du cycle de vie ; les entrées invalides restent signalées au point d'appel. */
  parseAgentOutput(text: string): PipelineInterviewProtocolState {
    const plan = extractSingleProposedPlan(text);
    const state = getProposedPlanInterviewState(plan);
    if (state === "question") {
      const question = extractClarificationQuestion(plan);
      if (!question) {
        throw new Error("Expected a non-empty <clarification_question> for interview_state question.");
      }
      const recommendedAnswer = extractRecommendedAnswer(plan) ?? undefined;
      return { state, question, recommendedAnswer, content: plan };
    }
    if (state === "ready") {
      return { state, artifact: plan, content: plan };
    }
    throw new Error('Expected <interview_state> to be "question" or "ready".');
  },

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  renderReplay({ originalPrompt, turns, completionRequested }): string {
    const history = turns.length === 0
      ? "No interview turns have been recorded yet."
      : turns.map(turn => `${turn.role === "agent" ? "Agent" : "User"}:\n${turn.content}`).join("\n\n");
    const completion = completionRequested
      ? [
        "The user has requested to complete the interview now.",
        'You must produce exactly one <proposed_plan> block with <interview_state>ready</interview_state>.',
        "Do not ask another question.",
      ].join("\n")
      : "Continue the interview or produce the ready plan if all decisions are resolved.";
    return [
      originalPrompt,
      "",
      "Interview history:",
      history,
      "",
      completion,
    ].join("\n");
  },

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  renderRepair({ prompt, diagnostic }): string {
    return [
      prompt,
      "",
      "Your previous response did not satisfy the proposed-plan protocol.",
      `Protocol error: ${diagnostic}`,
      "Return only one valid <proposed_plan> block. Use <interview_state>question</interview_state> with a non-empty <clarification_question>, or <interview_state>ready</interview_state> for the final plan.",
    ].join("\n");
  },

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  renderFinalOutputRequest({ prompt, diagnostic }): string {
    return [
      prompt,
      "",
      "The user has requested to complete the interview now.",
      `Final output error: ${diagnostic}`,
      "Return only one valid <proposed_plan> block with <interview_state>ready</interview_state>.",
      "Do not ask another question.",
    ].join("\n");
  },
};
