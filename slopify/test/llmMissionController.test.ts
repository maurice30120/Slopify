import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskBatchSnapshot } from '../src/taskBatch.js';
import {
  DECISION_MARKER, createLlmMissionController, mechanicalProofContract, parseControllerDecision,
  type ControllerLlmInvoker,
} from '../src/llmMissionController.js';
import type { ControllerTaskView } from '../src/missionController.js';
import { defaultMissionController } from '../src/missionController.js';

const snapshot = {} as TaskBatchSnapshot;
const view = (over: Partial<ControllerTaskView> = {}): ControllerTaskView => ({
  taskId: 'A', phase: 'implementation', status: 'running', corrections: 0, maxCorrections: 3, proofContract: [],
  ...over,
});

/** Fake déterministe : séquence de réponses textuelles, aucun token dépensé. */
function fakeInvoker(responses: string[]): ControllerLlmInvoker & { calls: string[] } {
  let index = 0;
  const calls: string[] = [];
  return {
    calls,
    async invoke({ prompt }) {
      calls.push(prompt);
      return { text: responses[Math.min(index++, responses.length - 1)], diagnostics: [] };
    },
  };
}

const planJson = JSON.stringify({ proofs: [{ id: 'http-proof', description: 'HTTP 200 sur /health' }], reason: 'API vérifiable' });
const correctJson = JSON.stringify({ mission: 'CORRECT', reason: 'finding corrigeable' });

test('the LLM controller parses a valid plan decision with custom proof contract', async () => {
  const controller = createLlmMissionController({ invoker: fakeInvoker([`analysis\n${DECISION_MARKER}${planJson}`]) });
  const plan = await controller.planImplementation(view(), snapshot);
  assert.deepEqual(plan.proofs, [{ id: 'http-proof', description: 'HTTP 200 sur /health' }]);
  assert.equal(plan.reason, 'API vérifiable');
});

test('the LLM controller parses a valid CORRECT decision', async () => {
  const controller = createLlmMissionController({ invoker: fakeInvoker([`${DECISION_MARKER}${correctJson}`]) });
  const decision = await controller.decideAfterReviewFailure(view({ corrections: 1 }), snapshot);
  assert.equal(decision.mission, 'CORRECT');
  assert.equal(decision.reason, 'finding corrigeable');
});

test('an unparsable plan response is retried exactly once, then falls back to the mechanical contract', async () => {
  const invoker = fakeInvoker(['no marker at all', 'still no marker']);
  const controller = createLlmMissionController({ invoker });
  const plan = await controller.planImplementation(view(), snapshot);
  assert.equal(invoker.calls.length, 2, 'exactly one retry');
  assert.ok(invoker.calls[1].includes('no valid SLOPIFY_DECISION'), 'the retry explains the expected marker');
  assert.deepEqual(plan.proofs, mechanicalProofContract('A'));
  assert.match(plan.reason, /Repli mécanique/);
});

test('a valid answer on the retry avoids the fallback', async () => {
  const invoker = fakeInvoker(['garbage', `ok\n${DECISION_MARKER}${planJson}`]);
  const controller = createLlmMissionController({ invoker });
  const plan = await controller.planImplementation(view(), snapshot);
  assert.equal(invoker.calls.length, 2);
  assert.deepEqual(plan.proofs, [{ id: 'http-proof', description: 'HTTP 200 sur /health' }]);
});

test('an unparsable FAIL decision falls back to STOP after exactly one retry', async () => {
  const invoker = fakeInvoker(['maybe?', 'nope']);
  const controller = createLlmMissionController({ invoker });
  const decision = await controller.decideAfterReviewFailure(view({ corrections: 0 }), snapshot);
  assert.equal(invoker.calls.length, 2);
  assert.equal(decision.mission, 'STOP');
  assert.match(decision.reason, /Repli sûr/);
});

test('the controller prompt carries durable state and past decisions, never worker transcripts', async () => {
  const snapshotWithHistory = {
    runId: 'run-1', status: 'running',
    decisions: [
      { at: '2026-10-19T08:00:00Z', taskId: 'A', action: 'IMPLEMENT', reason: 'contract' },
      { at: '2026-10-19T08:05:00Z', taskId: 'B', action: 'IMPLEMENT', reason: 'contract' },
    ],
  } as unknown as TaskBatchSnapshot;
  const invoker = fakeInvoker([`${DECISION_MARKER}${planJson}`]);
  const controller = createLlmMissionController({ invoker });
  await controller.planImplementation(view(), snapshotWithHistory);
  const prompt = invoker.calls[0];
  assert.ok(prompt.includes('pastDecisions'));
  assert.ok(prompt.includes('IMPLEMENT'));
  assert.ok(prompt.includes('"taskId":"A"'));
  assert.ok(!prompt.includes('SLOPIFY_RESULT='), 'no raw worker transcript leaks into the controller context');
  assert.ok(prompt.includes('maxCorrections'), 'the controller sees the correction budget');
});

test('parseControllerDecision rejects malformed payloads', () => {
  assert.equal(parseControllerDecision('nothing'), undefined);
  assert.equal(parseControllerDecision(`${DECISION_MARKER}not-json`), undefined);
  assert.equal(parseControllerDecision(`${DECISION_MARKER}${JSON.stringify({ mission: 'MAYBE', reason: 'x' })}`), undefined);
  assert.equal(parseControllerDecision(`${DECISION_MARKER}${JSON.stringify({ mission: 'CORRECT' })}`), undefined, 'missing reason');
  assert.equal(parseControllerDecision(`${DECISION_MARKER}${JSON.stringify({ proofs: [{ id: 'x' }], reason: 'r' })}`), undefined, 'proof without description');
  assert.equal(parseControllerDecision(`${DECISION_MARKER}{}\n${DECISION_MARKER}{}`), undefined, 'two markers');
  const plan = parseControllerDecision(`${DECISION_MARKER}${planJson}`);
  assert.ok(plan?.proofs?.length === 1);
  const stop = parseControllerDecision(`${DECISION_MARKER}${JSON.stringify({ mission: 'STOP', reason: 'impasse' })}`);
  assert.equal(stop?.mission, 'STOP');
});

test('the deterministic default controller remains available as the safe fallback', async () => {
  const plan = await defaultMissionController.planImplementation(view(), snapshot);
  assert.ok(plan.proofs.length > 0);
  const ceiling = await defaultMissionController.decideAfterReviewFailure(view({ corrections: 3, maxCorrections: 3 }), snapshot);
  assert.equal(ceiling.mission, 'STOP');
  const below = await defaultMissionController.decideAfterReviewFailure(view({ corrections: 0 }), snapshot);
  assert.equal(below.mission, 'CORRECT');
});

test('the mechanical contract demands report, green tests and green build', () => {
  const proofs = mechanicalProofContract('A');
  assert.deepEqual(proofs.map(p => p.id), ['implementation-report', 'tests-green', 'build-green']);
  for (const proof of proofs) assert.ok(proof.description.length > 0);
});
