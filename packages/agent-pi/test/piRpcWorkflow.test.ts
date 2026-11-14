import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { runPiRpcWorkflow, runPiCombinedFinalReview, MAX_REVIEW_CYCLES, type PiReviewOutcome } from '../src/piRpcWorkflow.js';
import type { PiRpcChannel, PiRpcChannelFactory } from '../src/piRpcSession.js';
import type { PiWorkflowEvent } from '../src/piRpcEvidence.js';

/** Fabrique de canaux RPC simulés : un processus fake par session, comportement scripté par rôle, sans aucun appel fournisseur. */
interface FakeFactoryOptions {
  /** Réponse de l'implémenteur pour chaque message (initial puis corrections). */
  implementerReply?: (message: string, promptIndex: number) => string;
  /** Comportement du reviewer pour chaque passage. */
  reviewerReply?: (cycle: number, message: string) => { final: string; standards?: string; spec?: string };
  /** Le processus implémenteur meurt avant le premier règlement. */
  implementerCrash?: boolean;
  /** Le reviewer meurt avant son règlement. */
  reviewerCrash?: boolean;
  /** Le reviewer ne répond jamais (pour l'annulation). */
  reviewerHangs?: boolean;
  /** Le sous-agent Standards du reviewer échoue. */
  reviewerStandardsFails?: boolean;
  /** Le reviewer observe une erreur fournisseur dans son tour. */
  reviewerProviderError?: boolean;
  promptRejected?: boolean;
  dirtyWorkspace?: boolean;
  cleanupFails?: boolean;
}

interface FakeChannelLog {
  role: 'implementer' | 'reviewer';
  prompts: string[];
  closed: boolean;
  exited: boolean;
}

async function fixture(t: { after(fn: () => Promise<void>): void }, options: FakeFactoryOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-pi-rpc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resultDirectory = path.join(root, 'attempt');
  await mkdir(resultDirectory, { recursive: true });
  const channels: FakeChannelLog[] = [];
  const events: PiWorkflowEvent[] = [];
  let reviewerPasses = 0;
  const factory: PiRpcChannelFactory = session => {
    const log: FakeChannelLog = { role: session.role, prompts: [], closed: false, exited: false };
    channels.push(log);
    const implementerReply = options.implementerReply ?? (() => 'Implemented.\nSLOPIFY_RESULT={"status":"succeeded"}');
    const reviewerReply = options.reviewerReply ?? (() => ({ final: 'SLOPIFY_REVIEW={"verdict":"approved"}', standards: 'Standards report', spec: 'Spec report' }));
    const emitSubagents = (standards?: string, spec?: string) => {
      session.onRecord(JSON.stringify({ type: 'tool_execution_end', toolName: 'subagent', isError: false, result: { details: { mode: 'parallel', results: [
        options.reviewerStandardsFails
          ? { agent: 'standards', exitCode: 1, stopReason: 'error', errorMessage: 'Mistral review request rejected' }
          : { agent: 'standards', exitCode: 0, messages: [{ role: 'assistant', content: [{ type: 'text', text: standards ?? 'Standards report' }] }] },
        { agent: 'spec', exitCode: 0, messages: [{ role: 'assistant', content: [{ type: 'text', text: spec ?? 'Spec report' }] }] },
      ] } } }));
    };
    const emitProviderError = () => {
      session.onRecord(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'HTTP 429 provider overloaded', content: [] } }));
    };
    const channel: PiRpcChannel = {
      writeLine: line => {
        const command = JSON.parse(line) as { id: string; type: string; message?: string };
        if (command.type !== 'prompt') return;
        log.prompts.push(command.message ?? '');
        if (options.promptRejected) {
          session.onRecord(JSON.stringify({ id: command.id, type: 'response', command: 'prompt', success: false, error: 'rejected' }));
          return;
        }
        session.onRecord(JSON.stringify({ id: command.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } }));
        if (session.role === 'implementer' && options.implementerCrash) {
          session.onExit({ exitCode: 1, stderrTail: 'pi: provider unavailable' });
          return;
        }
        if (session.role === 'reviewer' && options.reviewerCrash) {
          session.onExit({ exitCode: 137, stderrTail: 'killed' });
          return;
        }
        if (session.role === 'reviewer' && options.reviewerHangs) return;
        if (session.role === 'implementer') {
          const reply = implementerReply(command.message ?? '', log.prompts.length);
          session.onRecord(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } }));
        } else {
          reviewerPasses += 1;
          const reply = reviewerReply(reviewerPasses, command.message ?? '');
          emitSubagents(reply.standards, reply.spec);
          if (options.reviewerProviderError) emitProviderError();
          session.onRecord(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: reply.final }] } }));
        }
        session.onRecord(JSON.stringify({ type: 'agent_settled' }));
      },
      close: async () => { log.closed = true; if (!log.exited) { log.exited = true; session.onExit({ exitCode: 0, stderrTail: '' }); } if (options.cleanupFails) throw new Error('descendants uncertain'); return { exitCode: 0, stderrTail: '' }; },
      get alive() { return !log.exited; },
      describe: () => `fake pi rpc (${session.role})`,
    };
    return channel;
  };
  const run = (signal?: AbortSignal) => runPiRpcWorkflow({
    runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1', resultDirectory, signal,
    openChannel: factory,
    initialMessage: 'Initial approved ticket',
    reviewMessage: (cycle, previous) => `Review cycle ${cycle} (${previous.length} previous)`,
    correctionMessage: review => `Correct cycle ${review.cycle}: ${review.reason ?? ''}`,
    verifyReadyForReview: async () => { if (options.dirtyWorkspace) throw new Error('workspace is not committed'); },
    onEvent: event => events.push(event),
  });
  const runFinal = (signal?: AbortSignal) => runPiCombinedFinalReview({
    runId: 'run-1', taskId: 'final-review', attemptId: 'attempt-1', resultDirectory, signal,
    openChannel: factory,
    reviewMessage: 'Final combined review of the complete lot diff',
    onEvent: event => events.push(event),
  });
  const evidence = {
    sessions: async () => (await readFile(path.join(resultDirectory, 'pi-rpc', 'sessions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    reviews: async () => (await readFile(path.join(resultDirectory, 'pi-rpc', 'reviews.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    events: async () => (await readFile(path.join(resultDirectory, 'pi-rpc', 'workflow-events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
  };
  return { root, resultDirectory, channels, events, run, runFinal, evidence };
}

test('the combined final review runs exactly one fresh read-only reviewer session, closed after a distinct approval', async t => {
  const f = await fixture(t, {
    reviewerReply: () => ({ final: 'Final combined review findings\nSLOPIFY_REVIEW={"verdict":"approved"}', standards: 'Final Standards report', spec: 'Final Spec report' }),
  });
  const result = await f.runFinal();
  assert.equal(result.exitCode, 0, result.report);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(f.channels.filter(channel => channel.role === 'implementer').length, 0, 'the final review never starts an implementer session');
  const reviewers = f.channels.filter(channel => channel.role === 'reviewer');
  assert.equal(reviewers.length, 1, 'a single combined final review process');
  assert.equal(reviewers[0].prompts.length, 1, 'exactly one pass: no correction or second review ever follows');
  assert.match(reviewers[0].prompts[0], /Final combined review of the complete lot diff/);
  assert.ok(reviewers[0].closed, 'the reviewer session is closed after its verdict');
  assert.equal(result.verdict, 'approved');
  assert.equal(result.standards, 'Final Standards report', 'the Standards report stays distinct');
  assert.equal(result.spec, 'Final Spec report', 'the Spec report stays distinct');
  assert.match(result.report, /Final Standards report/);
  assert.match(result.report, /Final Spec report/);
  const reviews = await f.evidence.reviews();
  assert.deepEqual(reviews.map(review => [review.cycle, review.verdict, review.standards, review.spec]),
    [[1, 'approved', 'Final Standards report', 'Final Spec report']]);
  const events = await f.evidence.events();
  assert.ok(events.some(event => event.phase === 'review_started'), 'the final review start is observable');
  assert.ok(events.some(event => event.phase === 'review_verdict'), 'the final review verdict is observable');
  assert.equal(events.at(-1)!.phase, 'workflow_succeeded');
  const sessions = await f.evidence.sessions();
  const started = sessions.filter(record => record.event === 'started');
  assert.deepEqual([...new Set(started.map(record => record.role))], ['reviewer'], 'no implementer session is ever started for the final review');
  assert.ok(started[0].description.length > 0, 'the session process description is preserved as evidence');
});

test('a rejected combined final review fails the lot observably without any correction or new review', async t => {
  const f = await fixture(t, {
    reviewerReply: () => ({ final: 'Blocking integrated lot findings\nSLOPIFY_REVIEW={"verdict":"rejected","reason":"standards breach in the integrated lot"}',
      standards: 'Final Standards blocker report', spec: 'Final Spec blocker report' }),
  });
  const result = await f.runFinal();
  assert.equal(result.exitCode, 1, 'a rejected final review can never read as a success');
  assert.equal(result.verdict, 'rejected');
  assert.equal(result.reason, 'standards breach in the integrated lot');
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'pi_final_review_rejected' && /standards breach in the integrated lot/.test(diagnostic.message)),
    'the failure is reported through the public diagnostics, not folded into an approval');
  assert.equal(f.channels.filter(channel => channel.role === 'implementer').length, 0, 'a rejection never goes back to any implementer session');
  assert.equal(f.channels.filter(channel => channel.role === 'reviewer').length, 1, 'no new final review pass follows the rejection');
  assert.ok(f.channels[0].closed, 'the reviewer session is still closed after its reports');
  assert.match(result.report, /Final Standards blocker report/);
  assert.match(result.report, /Final Spec blocker report/);
  const events = await f.evidence.events();
  assert.equal(events.at(-1)!.phase, 'workflow_blocked', 'the lot ends blocked with its reports, without automatic relaunch');
  const reviews = await f.evidence.reviews();
  assert.equal(reviews[0].verdict, 'rejected');
  assert.equal(reviews[0].standards, 'Final Standards blocker report');
  assert.equal(reviews[0].spec, 'Final Spec blocker report');
});

test('an invalid combined final review verdict is a visible reviewer failure, never an approval', async t => {
  const f = await fixture(t, { reviewerReply: () => ({ final: 'Findings without any verdict line', standards: 'S', spec: 'P' }) });
  const result = await f.runFinal();
  assert.equal(result.exitCode, 1);
  assert.equal(result.verdict, undefined);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'pi_review_verdict_invalid'));
  assert.equal(f.channels.filter(channel => channel.role === 'reviewer').length, 1);
  const events = await f.evidence.events();
  assert.equal(events.at(-1)!.phase, 'workflow_failed');
});

test('two correction cycles run in the same persistent implementer session, with a fresh reviewer session per pass', async t => {
  const verdicts = ['rejected', 'rejected', 'approved'];
  const f = await fixture(t, {
    reviewerReply: cycle => ({ final: `Cycle ${cycle} findings\nSLOPIFY_REVIEW={"verdict":"${verdicts[cycle - 1]}","reason":"cycle ${cycle} findings"}`, standards: `Standards findings ${cycle}`, spec: `Spec findings ${cycle}` }),
  });
  const result = await f.run();
  assert.equal(result.exitCode, 0, result.report);
  assert.deepEqual(result.diagnostics, []);
  // Une seule session implémenteur, trois messages : initial + deux corrections.
  const implementer = f.channels.filter(channel => channel.role === 'implementer');
  assert.equal(implementer.length, 1, 'exactly one implementer process for the whole attempt');
  assert.equal(implementer[0].prompts.length, 3);
  assert.match(implementer[0].prompts[0], /Initial approved ticket/);
  assert.match(implementer[0].prompts[1], /Correct cycle 1: cycle 1 findings/);
  assert.match(implementer[0].prompts[2], /Correct cycle 2: cycle 2 findings/);
  // Trois sessions reviewer distinctes, une par passage, fermées après leurs rapports.
  const reviewers = f.channels.filter(channel => channel.role === 'reviewer');
  assert.equal(reviewers.length, 3);
  assert.ok(reviewers.every(channel => channel.prompts.length === 1));
  assert.ok(reviewers.every(channel => channel.closed), 'each reviewer session is closed after its reports');
  assert.equal(result.implementerSessionId !== result.reviews[0].sessionId, true);
  assert.equal(result.reviews[0].sessionId !== result.reviews[1].sessionId, true);
  assert.equal(result.reviews[1].sessionId !== result.reviews[2].sessionId, true);
  // Sessions durables : un started implémenteur, trois started reviewer d'identifiants distincts.
  const sessions = await f.evidence.sessions();
  const started = sessions.filter(record => record.event === 'started');
  assert.equal(started.filter(record => record.role === 'implementer').length, 1);
  assert.equal(started.filter(record => record.role === 'reviewer').length, 3);
  assert.equal(new Set(started.filter(record => record.role === 'reviewer').map(record => record.sessionId)).size, 3);
  // Les constats de chaque refus sont transmis comme nouveau message à la même session.
  const prompts = sessions.filter(record => record.event === 'prompt' && record.role === 'implementer');
  assert.deepEqual(prompts.map(record => record.sessionId), [result.implementerSessionId, result.implementerSessionId, result.implementerSessionId]);
  // Rapports de revue distincts par passage, verdicts persistés.
  const reviews = await f.evidence.reviews();
  assert.deepEqual(reviews.map(review => [review.cycle, review.verdict]), [[1, 'rejected'], [2, 'rejected'], [3, 'approved']]);
  assert.match(reviews[0].standards, /Standards findings 1/);
  assert.match(reviews[0].spec, /Spec findings 1/);
  assert.ok(result.report.includes('Standards findings 1') && result.report.includes('Spec findings 2'));
});

test('workflow events are ordered, sequenced and aggregated without internal raw messages', async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.exitCode, 0);
  const events = await f.evidence.events();
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1), 'sequence numbers are dense, stable and ordered');
  const phases = events.map(event => event.phase);
  assert.deepEqual(phases, [
    'session_started', 'implementation_started', 'implementation_settled',
    'session_started', 'review_started', 'review_settled', 'session_stopped', 'review_verdict',
    'session_stopped', 'workflow_succeeded',
  ]);
  // Corrélation : chaque événement porte run, tâche, tentative et session.
  for (const event of events) {
    assert.equal(event.runId, 'run-1');
    assert.equal(event.taskId, 'task-1');
    assert.equal(event.attemptId, 'attempt-1');
    assert.match(event.sessionId, /^[0-9a-f-]{36}$/);
  }
  // Les deltas et messages internes ne remontent jamais à l'hôte.
  assert.equal(f.events.every(event => !JSON.stringify(event).includes('Implemented.')), true);
});

test('a reviewer rejection three times blocks the ticket with its reports and no fourth cycle', async t => {
  const f = await fixture(t, {
    reviewerReply: cycle => ({ final: `SLOPIFY_REVIEW={"verdict":"rejected","reason":"cycle ${cycle} findings"}` }),
  });
  const result = await f.run();
  assert.equal(result.exitCode, 1);
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 'pi_review_exhausted'), true);
  assert.equal(MAX_REVIEW_CYCLES, 3);
  assert.equal(f.channels.filter(channel => channel.role === 'reviewer').length, 3, 'exactly three review passes');
  assert.equal(f.channels.filter(channel => channel.role === 'implementer').length, 1, 'no second implementer process is ever spawned');
  assert.equal(f.channels.find(channel => channel.role === 'implementer')!.prompts.length, 3, 'initial implementation plus two corrections, no correction after the third rejection');
  const events = await f.evidence.events();
  assert.equal(events.at(-1)!.phase, 'workflow_blocked');
  assert.match(events.at(-1)!.detail, /blocked with its reports and no automatic relaunch/);
});

test('an implementer session crash fails the attempt without spawning a duplicate process', async t => {
  const f = await fixture(t, { implementerCrash: true });
  const result = await f.run();
  assert.equal(result.exitCode, 1);
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 'pi_rpc_session_crashed' && /exited with code 1/.test(diagnostic.message) && /provider unavailable/.test(diagnostic.message)), true);
  assert.equal(f.channels.length, 1, 'no reviewer and no second implementer process after the crash');
  const events = await f.evidence.events();
  assert.equal(events.some(event => event.phase === 'session_crashed' && event.role === 'implementer'), true);
  assert.equal(events.at(-1)!.phase, 'workflow_failed');
});

test('a rejected RPC prompt fails without waiting for an event that will never arrive', { timeout: 3000 }, async t => {
  const f = await fixture(t, { promptRejected: true });
  const result = await f.run();
  assert.equal(result.exitCode, 1);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'pi_rpc_command_error'));
  assert.equal(f.channels.filter(channel => channel.role === 'reviewer').length, 0);
});

test('uncommitted implementation is never sent to review', async t => {
  const f = await fixture(t, { dirtyWorkspace: true });
  const result = await f.run();
  assert.equal(result.exitCode, 1);
  assert.ok(result.diagnostics.some(diagnostic => /workspace is not committed/.test(diagnostic.message)));
  assert.equal(f.channels.filter(channel => channel.role === 'reviewer').length, 0);
});

test('unconfirmed session cleanup cannot produce a successful workflow', async t => {
  const f = await fixture(t, { cleanupFails: true });
  const result = await f.run();
  assert.equal(result.exitCode, 1);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'pi_session_cleanup_failed'));
  assert.equal((await f.evidence.events()).at(-1).phase, 'workflow_failed');
});

test('a reviewer session crash fails the attempt observably, without inline fallback review', async t => {
  const f = await fixture(t, { reviewerCrash: true });
  const result = await f.run();
  assert.equal(result.exitCode, 1);
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 'pi_rpc_session_crashed' && /reviewer/.test(diagnostic.message)), true);
  assert.equal(f.channels.filter(channel => channel.role === 'reviewer').length, 1, 'no automatic reviewer relaunch after a crash');
  assert.equal(f.channels.filter(channel => channel.role === 'implementer')[0].prompts.length, 1, 'no correction is requested from a crashed review');
});

test('cancellation aborts the pending turn and stops the live sessions in order', async t => {
  const f = await fixture(t, { reviewerHangs: true });
  const controller = new AbortController();
  const pending = f.run(controller.signal);
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  const result = await pending;
  assert.equal(result.exitCode, 1);
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 'pi_workflow_cancelled'), true);
  const implementer = f.channels.find(channel => channel.role === 'implementer')!;
  const reviewer = f.channels.find(channel => channel.role === 'reviewer')!;
  assert.equal(implementer.closed, true, 'the persistent implementer session receives an ordered stop');
  assert.equal(reviewer.closed, true, 'the hanging reviewer session receives an ordered stop');
  const events = await f.evidence.events();
  assert.equal(events.at(-1)!.phase, 'workflow_cancelled');
});

test('an invalid reviewer verdict is a reviewer failure, never an approval nor a burned cycle', async t => {
  const f = await fixture(t, { reviewerReply: () => ({ final: 'I could not decide.' }) });
  const result = await f.run();
  assert.equal(result.exitCode, 1);
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 'pi_review_verdict_invalid'), true);
  assert.equal(f.channels.filter(channel => channel.role === 'reviewer').length, 1, 'no second review pass for an invalid verdict');
});

test('a failing Standards subagent prevents approval even when the reviewer approves', async t => {
  const f = await fixture(t, {
    reviewerStandardsFails: true,
    reviewerReply: () => ({ final: 'SLOPIFY_REVIEW={"verdict":"approved"}' }),
  });
  const result = await f.run();
  assert.equal(result.exitCode, 1);
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 'pi_subagent_error' && /standards/.test(diagnostic.message)), true,
    'a failed delegated Standards review is escalated as a diagnostic, never silently approved');
});

test('a provider error observed in a turn is escalated as a diagnostic', async t => {
  const f = await fixture(t, {
    implementerReply: () => 'Work done.\nSLOPIFY_RESULT={"status":"succeeded"}',
    reviewerProviderError: true,
    reviewerReply: () => ({ final: 'SLOPIFY_REVIEW={"verdict":"approved"}' }),
  });
  const result = await f.run();
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 'pi_provider_error' && /HTTP 429/.test(diagnostic.message)), true);
});

test('secrets in findings and reports are redacted from durable evidence and host events', async t => {
  const leak = "Authorization: Bearer sk-live-abcdef123456 and api_key='supersecret123'";
  const f = await fixture(t, {
    reviewerReply: cycle => cycle === 1
      ? { final: `SLOPIFY_REVIEW={"verdict":"rejected","reason":"leaky cycle: ${leak}"}` }
      : { final: 'SLOPIFY_REVIEW={"verdict":"approved"}' },
  });
  const result = await f.run();
  assert.equal(result.exitCode, 0);
  const reviewsRaw = await readFile(path.join(f.resultDirectory, 'pi-rpc', 'reviews.jsonl'), 'utf8');
  const eventsRaw = await readFile(path.join(f.resultDirectory, 'pi-rpc', 'workflow-events.jsonl'), 'utf8');
  const sessionsRaw = await readFile(path.join(f.resultDirectory, 'pi-rpc', 'sessions.jsonl'), 'utf8');
  for (const raw of [reviewsRaw, eventsRaw, sessionsRaw]) {
    assert.equal(raw.includes('sk-live-abcdef123456'), false, 'provider key material never persists');
    assert.equal(raw.includes('supersecret123'), false, 'api key values never persist');
  }
  assert.equal(reviewsRaw.includes('[redacted]'), true, 'the rejected review reason is persisted redacted');
  assert.equal(eventsRaw.includes('[redacted]'), true, 'the review verdict event is persisted redacted');
  assert.equal(JSON.stringify(f.events).includes('sk-live-abcdef123456'), false, 'host events never carry secrets');
  assert.equal(JSON.stringify(f.events).includes('supersecret123'), false, 'host events never carry api key values');
  // Le constat rédigé part bien à l'implémenteur comme nouveau message de correction.
  const correction = f.channels.find(channel => channel.role === 'implementer')!.prompts.at(-1)!;
  assert.match(correction, /leaky cycle: Authorization: Bearer \[redacted\] and api_key='\[redacted\]'/);
});

test('a failed implementer verdict fails the attempt before any review', async t => {
  const f = await fixture(t, {
    implementerReply: () => 'Blocked by missing dependency.\nSLOPIFY_RESULT={"status":"failed","reason":"missing input"}',
  });
  const result = await f.run();
  assert.equal(result.exitCode, 1);
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 'agent_reported_failure' && /missing input/.test(diagnostic.message)), true);
  assert.equal(f.channels.filter(channel => channel.role === 'reviewer').length, 0, 'no review of a self-reported failure');
});
