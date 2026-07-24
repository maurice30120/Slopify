import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertSingleProposedPlan,
  extractClarificationQuestion,
  extractRecommendedAnswer,
  getProposedPlanInterviewState,
  isProposedPlanAwaitingAnswer,
} from '../dist/index.js';

const QUESTION_PLAN = `<proposed_plan>
<interview_state>question</interview_state>
<clarification_question>Which public seam should own persistence?</clarification_question>
<recommended_answer>Use a repository interface.</recommended_answer>
</proposed_plan>`;

const READY_PLAN = `<proposed_plan>
<interview_state>ready</interview_state>
## Plan
Implement the approved skeleton.
</proposed_plan>`;

test('interactive proposed plans expose their pending question', () => {
  assert.equal(getProposedPlanInterviewState(QUESTION_PLAN), 'question');
  assert.equal(isProposedPlanAwaitingAnswer(QUESTION_PLAN), true);
  assert.equal(
    extractClarificationQuestion(QUESTION_PLAN),
    'Which public seam should own persistence?',
  );
  assert.equal(
    extractRecommendedAnswer(QUESTION_PLAN),
    'Use a repository interface.',
  );
});

test('ready proposed plans can be approved', () => {
  assert.equal(getProposedPlanInterviewState(READY_PLAN), 'ready');
  assert.equal(isProposedPlanAwaitingAnswer(READY_PLAN), false);
  assert.doesNotThrow(() => assertSingleProposedPlan(READY_PLAN));
});

test('question proposed plans cannot be approved', () => {
  assert.throws(
    () => assertSingleProposedPlan(QUESTION_PLAN),
    /interview is not complete/i,
  );
});

test('legacy proposed plans remain approvable', () => {
  const legacy = '<proposed_plan>Implement the feature.</proposed_plan>';
  assert.equal(getProposedPlanInterviewState(legacy), null);
  assert.doesNotThrow(() => assertSingleProposedPlan(legacy));
});
