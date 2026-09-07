import {
  extractQuestionRound,
  extractSingleProposedPlan,
  getProposedPlanInterviewState,
} from "./ProposedPlan";
import type { PipelineInterviewTurn } from "./PipelineV3Types";

export type PipelineInterviewProtocolState =
  | { state: "question"; questions: string[]; recommendedAnswers?: string[]; content: string }
  | { state: "ready"; artifact: unknown; content: string };

export interface PipelineInterviewProtocol {
  id: string;
  parseAgentOutput(text: string): PipelineInterviewProtocolState;
  renderReplay(context: {
    originalPrompt: string;
    turns: PipelineInterviewTurn[];
    completionRequested: boolean;
  }): string;
  renderRepair(context: {
    prompt: string;
    diagnostic: string;
  }): string;
  renderFinalOutputRequest(context: {
    prompt: string;
    diagnostic: string;
  }): string;
}

export const PROPOSED_PLAN_PROTOCOL_ID = "proposed-plan";

export function getPipelineInterviewProtocol(id: string): PipelineInterviewProtocol | undefined {
  return id === PROPOSED_PLAN_PROTOCOL_ID ? proposedPlanProtocol : undefined;
}

export function listPipelineInterviewProtocolIds(): string[] {
  return [PROPOSED_PLAN_PROTOCOL_ID];
}

const proposedPlanProtocol: PipelineInterviewProtocol = {
  id: PROPOSED_PLAN_PROTOCOL_ID,

  parseAgentOutput(text: string): PipelineInterviewProtocolState {
    const plan = extractSingleProposedPlan(text);
    const state = getProposedPlanInterviewState(plan);
    if (state === "question") {
      const round = extractQuestionRound(plan);
      if (!round) {
        throw new Error("Expected a non-empty Markdown question round for interview_state question.");
      }
      return {
        state,
        questions: [round],
        content: plan,
      };
    }
    if (state === "ready") {
      return { state, artifact: plan, content: plan };
    }
    throw new Error('Expected <interview_state> to be "question" or "ready".');
  },

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

  renderRepair({ prompt, diagnostic }): string {
    return [
      prompt,
      "",
      "Your previous response did not satisfy the proposed-plan protocol.",
      `Protocol error: ${diagnostic}`,
      "Return only one valid <proposed_plan> block. Use <interview_state>question</interview_state> followed by the complete non-empty Markdown question round (including recommendations), or <interview_state>ready</interview_state> for the final plan. After a question round, end the turn and wait for the user's answers.",
    ].join("\n");
  },

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
