import type { TaskDiagnostic } from '@slopify/execution';
import { agentOutcomeDiagnostics } from '@slopify/execution';
import { PiRpcEvidence, redactSecrets, type PiWorkflowEvent, type PiWorkflowPhase } from './piRpcEvidence.js';
import { PiRpcSession, type PiRpcChannelFactory, type PiRpcSessionRole, type PiRpcTurn } from './piRpcSession.js';

/** Nombre maximum de cycles de revue infructueux (politique existante : trois tentatives, puis blocage sans relance). */
export const MAX_REVIEW_CYCLES = 3;

/** Verdict d'un passage de revue indépendante, extrait du message final du reviewer. */
export interface PiReviewOutcome {
  cycle: number;
  sessionId: string;
  verdict: 'approved' | 'rejected';
  reason?: string;
  /** Rapport de l'axe Standards, distinct de l'axe Spec. */
  standards?: string;
  /** Rapport de l'axe Spec, distinct de l'axe Standards. */
  spec?: string;
  /** Constats actionnables rédigés, transmis comme nouveau message à la session implémenteur. */
  findings: string;
}

export interface PiRpcWorkflowOptions {
  runId: string;
  taskId: string;
  attemptId: string;
  resultDirectory: string;
  signal?: AbortSignal;
  /** Plafond de cycles de revue infructueux ; trois par défaut, sans nouveau compteur côté Scheduler. */
  maxReviewCycles?: number;
  /** Transport : ouvre le canal RPC d'une session (implémenteur persistant ou reviewer éphémère). */
  openChannel: PiRpcChannelFactory;
  /** Premier message envoyé à la session implémenteur persistante. */
  initialMessage: string;
  /** Brief de revue d'une session reviewer neuve, à chaque passage, avec les constats précédents à contrôler. */
  reviewMessage: (cycle: number, previous: PiReviewOutcome[]) => string;
  /** Message de correction : constats du reviewer envoyés comme NOUVEAU message à la même session implémenteur. */
  correctionMessage: (review: PiReviewOutcome) => string;
  /** Refuse review if the implementation has changes outside the committed diff. */
  verifyReadyForReview: () => Promise<void>;
  /** Remontée hôte agrégée : changements de phase seulement, jamais les messages internes bruts. */
  onEvent?: (event: PiWorkflowEvent) => void;
  now?: () => string;
}

export interface PiRpcWorkflowResult {
  exitCode: number;
  report: string;
  diagnostics: TaskDiagnostic[];
  /** Session implémenteur persistante : unique pour toute la tentative, tous cycles confondus. */
  implementerSessionId: string;
  /** Sessions reviewer : une session neuve par passage, fermée après émission des rapports. */
  reviews: PiReviewOutcome[];
  evidence: { sessionsPath: string; reviewsPath: string; eventsPath: string };
}

/** Échec du workflow : la tentative échoue avec ses diagnostics et rapports, sans relance automatique. */
class WorkflowFailed extends Error {}

/** Annulation par l'hôte : les sessions vivantes reçoivent un arrêt ordonné avant le retour. */
class WorkflowCancelled extends Error {}

/**
 * Workflow des agents Pi en RPC natif : une session implémenteur persistante par
 * ticket (implémentation, corrections, validations et commits successifs dans la
 * même conversation tant que le processus vit), et une session reviewer indépendante
 * neuve à chaque passage, fermée après l'émission de ses rapports. Chaque refus de
 * revue compte ; au plafond la tentative échoue avec ses rapports, sans relance
 * automatique. Un crash de session échoue la tentative : jamais deux processus
 * concurrents pour le même ticket, aucune mémoire volatile restaurée — la reprise
 * repart des preuves durables et du checkpoint Git par une nouvelle session.
 */
export async function runPiRpcWorkflow(options: PiRpcWorkflowOptions): Promise<PiRpcWorkflowResult> {
  const maxCycles = options.maxReviewCycles ?? MAX_REVIEW_CYCLES;
  const signal = options.signal;
  const evidence = new PiRpcEvidence({
    runId: options.runId, taskId: options.taskId, attemptId: options.attemptId,
    resultDirectory: options.resultDirectory, onEvent: options.onEvent, now: options.now,
  });
  const diagnostics: TaskDiagnostic[] = [];
  const reports: string[] = [];
  const reviews: PiReviewOutcome[] = [];
  let implementer: PiRpcSession | undefined;
  let reviewer: PiRpcSession | undefined;

  const now = () => new Date().toISOString();

  /** Annulation contrôlée puis arrêt ordonné de toute session encore vivante ; un arrêt défaillant ne masque jamais le diagnostic initial. */
  const stopLiveSessions = async (): Promise<void> => {
    for (const session of [implementer, reviewer]) {
      if (!session) continue;
      if (session.alive) try { await session.abort(); } catch { /* best effort */ }
      try { await session.stop(); } catch (error) {
        diagnostics.push({ code: 'pi_session_cleanup_failed', message: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  const startSession = async (role: PiRpcSessionRole, cycle: number): Promise<PiRpcSession> => {
    const session = new PiRpcSession({ role, openChannel: options.openChannel });
    await evidence.session({ timestamp: now(), role, sessionId: session.sessionId, event: 'started', cycle, description: redactSecrets(session.describe()) });
    await evidence.event('session_started', { role, sessionId: session.sessionId, cycle, detail: session.describe() });
    return session;
  };

  /** Interrompt l'attente d'un tour si l'hôte annule ; l'arrêt ordonné est fait par l'appelant. */
  const raceAbort = <T>(pending: Promise<T>): Promise<T> => {
    if (!signal) return pending;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new WorkflowCancelled());
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); },
        error => { signal.removeEventListener('abort', onAbort); reject(error); });
    });
  };

  /** Un tour complet : message envoyé à la session, résultat terminal attendu, crash distingué du règlement. */
  const runTurn = async (session: PiRpcSession, role: PiRpcSessionRole, cycle: number, message: string, settledPhase: PiWorkflowPhase): Promise<PiRpcTurn> => {
    await evidence.session({ timestamp: now(), role, sessionId: session.sessionId, event: 'prompt', cycle, promptChars: message.length });
    let turn: PiRpcTurn;
    try { turn = await raceAbort(session.prompt(message)); }
    catch (error) {
      if (error instanceof WorkflowCancelled) throw error;
      diagnostics.push({ code: 'pi_workflow_failed', message: error instanceof Error ? error.message : String(error) });
      throw new WorkflowFailed();
    }
    if (!turn.settled) {
      const exit = session.exited ?? { exitCode: 1, stderrTail: '' };
      await evidence.session({ timestamp: now(), role, sessionId: session.sessionId, event: 'exit', cycle, exitCode: exit.exitCode, detail: redactSecrets(exit.stderrTail).slice(0, 2000) });
      await evidence.event('session_crashed', { role, sessionId: session.sessionId, cycle, detail: `Pi RPC ${role} process exited with code ${exit.exitCode} before settling.` });
      diagnostics.push({ code: 'pi_rpc_session_crashed', message: `Pi RPC ${role} session ${session.sessionId} exited with code ${exit.exitCode} before agent_settled${exit.stderrTail ? `: ${redactSecrets(exit.stderrTail).slice(0, 500)}` : ''}.` });
      throw new WorkflowFailed();
    }
    await evidence.session({ timestamp: now(), role, sessionId: session.sessionId, event: 'settled', cycle });
    await evidence.event(settledPhase, { role, sessionId: session.sessionId, cycle });
    return turn;
  };

  /** Arrêt ordonné d'une session vivante, journalisé comme preuve. */
  const stopSession = async (session: PiRpcSession, role: PiRpcSessionRole, cycle: number): Promise<void> => {
    const closed = await session.stop();
    await evidence.session({ timestamp: now(), role, sessionId: session.sessionId, event: 'stopped', cycle, exitCode: closed.exitCode });
    await evidence.event('session_stopped', { role, sessionId: session.sessionId, cycle, detail: `Ordered stop, exit code ${closed.exitCode}.` });
  };

  /** Verdict explicite de l'implémenteur : absent ou failed, la tentative échoue sans revue. */
  const implementerVerdictFails = (turn: PiRpcTurn): boolean => {
    const verdictDiagnostics = agentOutcomeDiagnostics(turn.finalText);
    if (verdictDiagnostics.length === 0) return false;
    diagnostics.push(...verdictDiagnostics);
    return true;
  };

  const finish = async (exitCode: number, phase: PiWorkflowPhase, detail: string): Promise<PiRpcWorkflowResult> => {
    await stopLiveSessions();
    if (diagnostics.some(diagnostic => diagnostic.code === 'pi_session_cleanup_failed')) {
      exitCode = 1;
      phase = 'workflow_failed';
      detail = 'A Pi session or its descendants could not be confirmed stopped.';
    }
    await evidence.event(phase, { role: 'implementer', sessionId: implementer?.sessionId ?? 'none', cycle: reviews.length, detail, evidencePath: exitCode === 0 ? evidence.eventsPath : evidence.reviewsPath });
    return {
      exitCode,
      report: reports.join('\n\n'),
      diagnostics,
      implementerSessionId: implementer?.sessionId ?? 'none',
      reviews,
      evidence: { sessionsPath: evidence.sessionsPath, reviewsPath: evidence.reviewsPath, eventsPath: evidence.eventsPath },
    };
  };

  try {
    // Session implémenteur persistante : ouverte une seule fois pour toute la tentative.
    implementer = await startSession('implementer', 0);
    await evidence.event('implementation_started', { role: 'implementer', sessionId: implementer.sessionId, cycle: 0, detail: 'Initial ticket prompt sent to the persistent implementer session.' });
    const initial = await runTurn(implementer, 'implementer', 0, options.initialMessage, 'implementation_settled');
    reports.push(...initial.reports);
    diagnostics.push(...initial.diagnostics);
    if (initial.diagnostics.length) throw new WorkflowFailed();
    if (implementerVerdictFails(initial)) throw new WorkflowFailed();

    for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
      await options.verifyReadyForReview();
      // Reviewer : session RPC indépendante neuve à chaque passage, en lecture seule.
      reviewer = await startSession('reviewer', cycle);
      await evidence.event('review_started', { role: 'reviewer', sessionId: reviewer.sessionId, cycle, detail: `Independent review cycle ${cycle} of the complete diff.` });
      const reviewTurn = await runTurn(reviewer, 'reviewer', cycle, options.reviewMessage(cycle, reviews), 'review_settled');
      reports.push(...reviewTurn.reports);
      diagnostics.push(...reviewTurn.diagnostics);
      // An explicit approval cannot replace a failed or missing independent review.
      if (reviewTurn.diagnostics.length > 0 || !['standards', 'spec'].every(axis =>
        reviewTurn.subagents.some(child => child.agent === axis && child.exitCode === 0 && child.text.trim()))) {
        diagnostics.push({ code: 'pi_review_incomplete', message: 'Independent Standards and Spec reviews must both complete successfully with reports.' });
        throw new WorkflowFailed();
      }
      const outcome = reviewVerdict(cycle, reviewer.sessionId, reviewTurn);
      // Un verdict invalide est une défaillance observable du reviewer, jamais une approbation ni un cycle brûlé.
      if ('invalid' in outcome) {
        diagnostics.push({ code: 'pi_review_verdict_invalid', message: `${outcome.invalid} Reviewer session ${reviewer.sessionId} final message follows: ${reviewTurn.finalText.slice(0, 1000)}` });
        throw new WorkflowFailed();
      }
      reviews.push(outcome);
      await evidence.review({ timestamp: now(), cycle, sessionId: reviewer.sessionId, verdict: outcome.verdict, ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}), ...(outcome.standards !== undefined ? { standards: outcome.standards } : {}), ...(outcome.spec !== undefined ? { spec: outcome.spec } : {}) });
      // La session reviewer est fermée après l'émission de ses rapports, à chaque passage.
      await stopSession(reviewer, 'reviewer', cycle);
      await evidence.event('review_verdict', { role: 'reviewer', sessionId: reviewer.sessionId, cycle, detail: `Cycle ${cycle} verdict: ${outcome.verdict}${outcome.reason ? `: ${outcome.reason}` : ''}.`, evidencePath: evidence.reviewsPath });
      reviewer = undefined;
      if (outcome.verdict === 'approved') {
        await stopSession(implementer, 'implementer', cycle);
        return await finish(0, 'workflow_succeeded', `Approved after ${cycle} review cycle${cycle > 1 ? 's' : ''}.`);
      }
      if (cycle >= maxCycles) {
        diagnostics.push({ code: 'pi_review_exhausted', message: `Independent review rejected the work ${maxCycles} times (policy limit); the ticket is blocked with its reports. Last findings: ${outcome.findings.slice(0, 2000)}` });
        return await finish(1, 'workflow_blocked', `Review rejected ${maxCycles} times; the ticket is blocked with its reports and no automatic relaunch.`);
      }
      // Refus : les constats partent comme NOUVEAU message à la même session implémenteur, sans recréer le contexte.
      await evidence.event('correction_requested', { role: 'implementer', sessionId: implementer.sessionId, cycle, detail: `Cycle ${cycle} findings sent to the persistent implementer session.`, evidencePath: evidence.reviewsPath });
      const correction = await runTurn(implementer, 'implementer', cycle, options.correctionMessage(outcome), 'correction_settled');
      reports.push(...correction.reports);
      diagnostics.push(...correction.diagnostics);
      if (correction.diagnostics.length) throw new WorkflowFailed();
      if (implementerVerdictFails(correction)) throw new WorkflowFailed();
    }
    throw new WorkflowFailed();
  } catch (error) {
    if (error instanceof WorkflowCancelled) {
      diagnostics.push({ code: 'pi_workflow_cancelled', message: 'Pi RPC workflow was cancelled; live sessions received an ordered stop.' });
      return await finish(1, 'workflow_cancelled', 'Cancelled by the host; live sessions stopped in order.');
    }
    if (error instanceof WorkflowFailed) {
      return await finish(1, 'workflow_failed', diagnostics.map(diagnostic => diagnostic.message).join(' | ').slice(0, 2000));
    }
    diagnostics.push({ code: 'pi_workflow_failed', message: error instanceof Error ? error.message : String(error) });
    return await finish(1, 'workflow_failed', diagnostics.map(diagnostic => diagnostic.message).join(' | ').slice(0, 2000));
  }
}

/** Critères d'exécution de la revue finale combinée du lot intégré. */
export interface PiFinalReviewOptions {
  runId: string;
  taskId: string;
  attemptId: string;
  resultDirectory: string;
  signal?: AbortSignal;
  /** Transport : ouvre le canal RPC de la session reviewer neuve de la revue finale. */
  openChannel: PiRpcChannelFactory;
  /** Brief unique envoyé à la session reviewer : revue du diff complet du lot, délégation des deux axes, verdict explicite. */
  reviewMessage: string;
  /** Remontée hôte agrégée : changements de phase seulement, jamais les messages internes bruts. */
  onEvent?: (event: PiWorkflowEvent) => void;
  now?: () => string;
}

/** Verdict de la revue finale combinée : rapports des deux axes distincts, constats rédigés, sans correction. */
export interface PiFinalReviewResult {
  exitCode: number;
  report: string;
  diagnostics: TaskDiagnostic[];
  /** Session reviewer neuve de la revue finale, fermée après l'émission du verdict. */
  sessionId: string;
  verdict?: 'approved' | 'rejected';
  reason?: string;
  findings?: string;
  /** Rapport de l'axe Standards, distinct de l'axe Spec. */
  standards?: string;
  /** Rapport de l'axe Spec, distinct de l'axe Standards. */
  spec?: string;
  evidence: { sessionsPath: string; reviewsPath: string; eventsPath: string };
}

/**
 * Revue finale combinée du lot intégré : une seule session reviewer Pi neuve et
 * indépendante, qui reçoit le diff complet du lot et délègue les axes Standards
 * et Spec en lecture seule ; elle est fermée après l'émission de ses rapports.
 * Un refus remonte ses constats comme échec visible (le lot n'est pas déclaré
 * réussi) sans relancer d'implémenteur ni de nouvelle revue : aucun correctif
 * automatique ne suit, la suite relève de la décision explicite de l'agent hôte.
 */
export async function runPiCombinedFinalReview(options: PiFinalReviewOptions): Promise<PiFinalReviewResult> {
  const signal = options.signal;
  const evidence = new PiRpcEvidence({
    runId: options.runId, taskId: options.taskId, attemptId: options.attemptId,
    resultDirectory: options.resultDirectory, onEvent: options.onEvent, now: options.now,
  });
  const diagnostics: TaskDiagnostic[] = [];
  const reports: string[] = [];
  let reviewer: PiRpcSession | undefined;
  let review: PiReviewOutcome | undefined;
  const now = () => new Date().toISOString();

  /** Arrêt ordonné de la session reviewer vivante, journalisé comme preuve ; un arrêt défaillant escalade en échec. */
  const stopSession = async (session: PiRpcSession): Promise<void> => {
    const closed = await session.stop();
    await evidence.session({ timestamp: now(), role: 'reviewer', sessionId: session.sessionId, event: 'stopped', cycle: 1, exitCode: closed.exitCode });
    await evidence.event('session_stopped', { role: 'reviewer', sessionId: session.sessionId, cycle: 1, detail: `Ordered stop, exit code ${closed.exitCode}.` });
  };

  const finish = async (exitCode: number, phase: PiWorkflowPhase, detail: string): Promise<PiFinalReviewResult> => {
    // Identifiant de session capturé avant l'arrêt ordonné : le verdict et les rapports restent corrélés dans les preuves.
    const sessionId = reviewer?.sessionId ?? review?.sessionId ?? 'none';
    if (reviewer) {
      if (reviewer.alive) try { await reviewer.abort(); } catch { /* best effort */ }
      try { await stopSession(reviewer); } catch (error) {
        diagnostics.push({ code: 'pi_session_cleanup_failed', message: error instanceof Error ? error.message : String(error) });
      }
      reviewer = undefined;
    }
    if (diagnostics.some(diagnostic => diagnostic.code === 'pi_session_cleanup_failed')) {
      exitCode = 1; phase = 'workflow_failed'; detail = 'A Pi session or its descendants could not be confirmed stopped.';
    }
    await evidence.event(phase, { role: 'reviewer', sessionId, cycle: 1, detail, evidencePath: exitCode === 0 ? evidence.eventsPath : evidence.reviewsPath });
    return {
      exitCode, report: reports.join('\n\n'), diagnostics,
      sessionId: review?.sessionId ?? 'none',
      ...(review?.verdict !== undefined ? { verdict: review.verdict } : {}),
      ...(review?.reason !== undefined ? { reason: review.reason } : {}),
      ...(review?.findings !== undefined ? { findings: review.findings } : {}),
      ...(review?.standards !== undefined ? { standards: review.standards } : {}),
      ...(review?.spec !== undefined ? { spec: review.spec } : {}),
      evidence: { sessionsPath: evidence.sessionsPath, reviewsPath: evidence.reviewsPath, eventsPath: evidence.eventsPath },
    };
  };

  /** Interrompt l'attente d'un tour si l'hôte annule ; l'arrêt ordonné est fait par finish. */
  const raceAbort = <T>(pending: Promise<T>): Promise<T> => {
    if (!signal) return pending;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new WorkflowCancelled());
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); },
        error => { signal.removeEventListener('abort', onAbort); reject(error); });
    });
  };

  class ReviewFailed extends Error {}

  try {
    // Session reviewer neuve et indépendante pour toute la revue finale, en lecture seule.
    reviewer = new PiRpcSession({ role: 'reviewer', openChannel: options.openChannel });
    const sessionId = reviewer.sessionId;
    await evidence.session({ timestamp: now(), role: 'reviewer', sessionId, event: 'started', cycle: 1, description: redactSecrets(reviewer.describe()) });
    await evidence.event('review_started', { role: 'reviewer', sessionId, cycle: 1, detail: 'Combined final review of the integrated lot diff in a fresh read-only session.' });
    await evidence.session({ timestamp: now(), role: 'reviewer', sessionId, event: 'prompt', cycle: 1, promptChars: options.reviewMessage.length });
    let turn: PiRpcTurn;
    try { turn = await raceAbort(reviewer.prompt(options.reviewMessage)); }
    catch (error) {
      if (error instanceof WorkflowCancelled) throw error;
      diagnostics.push({ code: 'pi_workflow_failed', message: error instanceof Error ? error.message : String(error) });
      throw new ReviewFailed();
    }
    if (!turn.settled) {
      const exit = reviewer.exited ?? { exitCode: 1, stderrTail: '' };
      await evidence.session({ timestamp: now(), role: 'reviewer', sessionId, event: 'exit', cycle: 1, exitCode: exit.exitCode, detail: redactSecrets(exit.stderrTail).slice(0, 2000) });
      await evidence.event('session_crashed', { role: 'reviewer', sessionId, cycle: 1, detail: `Pi RPC reviewer process exited with code ${exit.exitCode} before settling.` });
      diagnostics.push({ code: 'pi_rpc_session_crashed', message: `Pi RPC reviewer session ${sessionId} exited with code ${exit.exitCode} before agent_settled${exit.stderrTail ? `: ${redactSecrets(exit.stderrTail).slice(0, 500)}` : ''}.` });
      throw new ReviewFailed();
    }
    await evidence.session({ timestamp: now(), role: 'reviewer', sessionId, event: 'settled', cycle: 1 });
    await evidence.event('review_settled', { role: 'reviewer', sessionId, cycle: 1 });
    reports.push(...turn.reports);
    diagnostics.push(...turn.diagnostics);
    // Une approbation explicite ne remplace jamais une revue Standards/Spec incomplete ou défaillante.
    if (turn.diagnostics.length > 0 || !['standards', 'spec'].every(axis =>
      turn.subagents.some(child => child.agent === axis && child.exitCode === 0 && child.text.trim()))) {
      diagnostics.push({ code: 'pi_review_incomplete', message: 'Independent Standards and Spec reviews must both complete successfully with reports.' });
      throw new ReviewFailed();
    }
    const outcome = reviewVerdict(1, sessionId, turn);
    if ('invalid' in outcome) {
      diagnostics.push({ code: 'pi_review_verdict_invalid', message: `${outcome.invalid} Reviewer session ${sessionId} final message follows: ${turn.finalText.slice(0, 1000)}` });
      throw new ReviewFailed();
    }
    review = outcome;
    await evidence.review({ timestamp: now(), cycle: 1, sessionId, verdict: outcome.verdict,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      ...(outcome.standards !== undefined ? { standards: outcome.standards } : {}),
      ...(outcome.spec !== undefined ? { spec: outcome.spec } : {}) });
    await evidence.event('review_verdict', { role: 'reviewer', sessionId, cycle: 1, detail: `Final combined review verdict: ${outcome.verdict}${outcome.reason ? `: ${outcome.reason}` : ''}.`, evidencePath: evidence.reviewsPath });
    // La session reviewer est fermée après l'émission de ses rapports, comme à chaque passage de revue.
    try { await stopSession(reviewer); } catch (error) {
      diagnostics.push({ code: 'pi_session_cleanup_failed', message: error instanceof Error ? error.message : String(error) });
    }
    reviewer = undefined;
    if (outcome.verdict === 'approved') {
      return await finish(0, 'workflow_succeeded', 'Combined final review approved the integrated lot after one read-only pass.');
    }
    // Refus : constat visible et échec du lot ; aucune correction automatique ni nouvelle revue n'est lancée.
    diagnostics.push({ code: 'pi_final_review_rejected', message: `Combined final review rejected the integrated lot${outcome.reason ? `: ${outcome.reason}` : ''}. Findings are reported without any automatic correction: ${outcome.findings.slice(0, 2000)}` });
    return await finish(1, 'workflow_blocked', 'Combined final review rejected the integrated lot; findings are reported and the host decides what follows.');
  } catch (error) {
    if (error instanceof WorkflowCancelled) {
      diagnostics.push({ code: 'pi_workflow_cancelled', message: 'Pi RPC combined final review was cancelled; the live reviewer session received an ordered stop.' });
      return await finish(1, 'workflow_cancelled', 'Cancelled by the host; the live reviewer session was stopped in order.');
    }
    if (error instanceof ReviewFailed) {
      return await finish(1, 'workflow_failed', diagnostics.map(diagnostic => diagnostic.message).join(' | ').slice(0, 2000));
    }
    diagnostics.push({ code: 'pi_workflow_failed', message: error instanceof Error ? error.message : String(error) });
    return await finish(1, 'workflow_failed', diagnostics.map(diagnostic => diagnostic.message).join(' | ').slice(0, 2000));
  }
}

type ReviewVerdict = PiReviewOutcome | { invalid: string };

/** Extrait le verdict d'un passage de revue du message final du reviewer ; un verdict absent ou invalide n'approuve jamais. */
function reviewVerdict(cycle: number, sessionId: string, turn: PiRpcTurn): ReviewVerdict {
  const standards = turn.subagents.find(child => child.agent === 'standards');
  const spec = turn.subagents.find(child => child.agent === 'spec');
  const findings = redactSecrets(turn.finalText);
  const verdictLines = turn.finalText.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('SLOPIFY_REVIEW='));
  if (verdictLines.length !== 1) {
    return { invalid: 'The reviewer final message must contain exactly one SLOPIFY_REVIEW verdict line.' };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(verdictLines[0].slice('SLOPIFY_REVIEW='.length)); }
  catch { return { invalid: 'SLOPIFY_REVIEW must contain valid JSON.' }; }
  const verdict = record(parsed);
  if (!verdict || (verdict.verdict !== 'approved' && verdict.verdict !== 'rejected')) {
    return { invalid: 'SLOPIFY_REVIEW verdict must be approved or rejected.' };
  }
  if (verdict.verdict === 'approved') {
    return { cycle, sessionId, verdict: 'approved', findings, ...(standards?.text !== undefined ? { standards: standards.text } : {}), ...(spec?.text !== undefined ? { spec: spec.text } : {}) };
  }
  // Le constat rédigé circule vers l'implémenteur et les preuves : jamais de secret non rédigé.
  const reason = redactSecrets(typeof verdict.reason === 'string' ? verdict.reason : 'Independent review rejected the work.');
  return { cycle, sessionId, verdict: 'rejected', reason, findings, ...(standards?.text !== undefined ? { standards: standards.text } : {}), ...(spec?.text !== undefined ? { spec: spec.text } : {}) };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
