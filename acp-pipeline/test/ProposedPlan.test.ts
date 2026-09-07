import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSingleProposedPlan, extractQuestionRound, getProposedPlanInterviewState } from '../dist/index.js';

const round = `❓ **Q1** - Which public seam should own persistence?

➡️ Use a repository interface.

---

❓ **Q2** - How are transactions bounded?

➡️ Per-request unit of work.`;
const question = `<proposed_plan><interview_state>question</interview_state>\n${round}\n</proposed_plan>`;
const ready = '<proposed_plan><interview_state>ready</interview_state>Implement the approved skeleton.</proposed_plan>';

test('question round preserves Markdown questions and recommendations together', () => {
  assert.equal(getProposedPlanInterviewState(question), 'question');
  assert.equal(extractQuestionRound(question), round);
  assert.throws(() => assertSingleProposedPlan(question), /interview is not complete/i);
});

test('ready plans can be approved and contain no pending question round', () => {
  assert.equal(extractQuestionRound(ready), null);
  assert.doesNotThrow(() => assertSingleProposedPlan(ready));
});
