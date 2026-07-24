const OPEN_TAG = '<proposed_plan>';
const CLOSE_TAG = '</proposed_plan>';
const PROPOSED_PLAN_RE = /<proposed_plan>[\s\S]*?<\/proposed_plan>/g;
const INTERVIEW_STATE_RE = /<interview_state>\s*(question|ready)\s*<\/interview_state>/i;
const CLARIFICATION_QUESTION_RE = /<clarification_question>\s*([\s\S]*?)\s*<\/clarification_question>/i;
const RECOMMENDED_ANSWER_RE = /<recommended_answer>\s*([\s\S]*?)\s*<\/recommended_answer>/i;

export type ProposedPlanInterviewState = 'question' | 'ready' | null;

export function extractSingleProposedPlan(text: string): string {
  const matches = text.match(PROPOSED_PLAN_RE) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `Planner response did not include a ${OPEN_TAG} block.`
        : `Planner response included ${matches.length} ${OPEN_TAG} blocks; expected exactly one.`,
    );
  }
  return matches[0].trim();
}

export function getProposedPlanInterviewState(text: string): ProposedPlanInterviewState {
  const plan = extractSingleProposedPlan(text);
  const match = plan.match(INTERVIEW_STATE_RE);
  return (match?.[1]?.toLowerCase() as Exclude<ProposedPlanInterviewState, null> | undefined) ?? null;
}

export function isProposedPlanAwaitingAnswer(text: string): boolean {
  return getProposedPlanInterviewState(text) === 'question';
}

export function extractClarificationQuestion(text: string): string | null {
  const plan = extractSingleProposedPlan(text);
  return plan.match(CLARIFICATION_QUESTION_RE)?.[1]?.trim() || null;
}

export function extractRecommendedAnswer(text: string): string | null {
  const plan = extractSingleProposedPlan(text);
  return plan.match(RECOMMENDED_ANSWER_RE)?.[1]?.trim() || null;
}

export function assertSingleProposedPlan(text: string): void {
  const matches = text.match(PROPOSED_PLAN_RE) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `The approved plan must include one ${OPEN_TAG} block.`
        : `The approved plan must include exactly one ${OPEN_TAG} block; found ${matches.length}.`,
    );
  }
  const plan = matches[0];
  const before = text.slice(0, text.indexOf(plan)).trim();
  const after = text.slice(text.indexOf(plan) + plan.length).trim();
  if (before || after) {
    throw new Error(`The approved plan must contain only one ${OPEN_TAG}...${CLOSE_TAG} block.`);
  }
  if (isProposedPlanAwaitingAnswer(plan)) {
    throw new Error('The planner interview is not complete. Answer the pending question before approving the plan.');
  }
}
