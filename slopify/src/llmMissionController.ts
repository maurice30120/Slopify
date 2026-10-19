import * as path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { SubprocessExecutor } from '@acp-client/sandbox';
import { DockerTaskExecutor } from './dockerTaskExecutor.js';
import type { TaskAgent, TaskBatchDiagnostic, TaskBatchSnapshot } from './taskBatch.js';
import type { ControllerTaskView, MissionController, ProofRequirement } from './missionController.js';

export const DECISION_MARKER = 'SLOPIFY_DECISION=';

/** Invocation à la demande du LLM du contrôleur ; jamais un processus permanent. */
export interface ControllerLlmInvoker {
  invoke(request: { prompt: string; snapshot: TaskBatchSnapshot }): Promise<{ text: string; diagnostics: TaskBatchDiagnostic[] }>;
}

/** Décision typée attendue du contrôleur pour le contrat de preuves initial. */
export interface PlanDecision {
  proofs: ProofRequirement[];
  reason: string;
}

/** Décision typée attendue du contrôleur après une review FAIL. */
export interface CorrectDecision {
  mission: 'CORRECT' | 'STOP';
  reason: string;
}

/** Contrat par défaut mécanique : critères de la tâche vers preuves attendues, tests et build verts. */
export function mechanicalProofContract(taskId: string): ProofRequirement[] {
  return [
    { id: 'implementation-report', description: `Référence vers le rapport final du ticket ${taskId} et ses validations exécutées.` },
    { id: 'tests-green', description: `Sortie vérifiable de la suite de tests requise par le ticket ${taskId}, tous verts.` },
    { id: 'build-green', description: `Sortie vérifiable du build du monorepo, sans échec.` },
  ];
}

/** Extrait et valide la décision SLOPIFY_DECISION du message final du contrôleur.
 * Une réponse absente ou invalide est un échec de décision, jamais une décision par défaut silencieuse. */
export function parseControllerDecision(finalMessage: string): { proofs?: ProofRequirement[]; mission?: 'CORRECT' | 'STOP'; reason?: string } | undefined {
  const lines = finalMessage.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith(DECISION_MARKER));
  if (lines.length !== 1) return undefined;
  let outcome: unknown;
  try { outcome = JSON.parse(lines[0].slice(DECISION_MARKER.length)); }
  catch { return undefined; }
  if (outcome === null || typeof outcome !== 'object' || Array.isArray(outcome)) return undefined;
  const record = outcome as Record<string, unknown>;
  if (typeof record.reason !== 'string' || record.reason.trim().length === 0) return undefined;
  if (Array.isArray(record.proofs)) {
    const proofs: ProofRequirement[] = [];
    for (const value of record.proofs) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const requirement = value as Record<string, unknown>;
      if (typeof requirement.id !== 'string' || requirement.id.trim().length === 0) return undefined;
      if (typeof requirement.description !== 'string' || requirement.description.trim().length === 0) return undefined;
      proofs.push({ id: requirement.id, description: requirement.description });
    }
    return { proofs, reason: record.reason };
  }
  if (record.mission === 'CORRECT' || record.mission === 'STOP') {
    return { mission: record.mission, reason: record.reason };
  }
  return undefined;
}

/** État synthétique du contrôleur : la vue de la tâche, les décisions passées et le statut du run ; jamais les transcripts. */
function controllerContext(view: ControllerTaskView, snapshot: TaskBatchSnapshot): string {
  const pastDecisions = (snapshot.decisions ?? []).filter(decision => decision.taskId === view.taskId)
    .map(decision => ({ at: decision.at, taskId: decision.taskId, action: decision.action, reason: decision.reason }));
  return JSON.stringify({
    task: {
      id: view.taskId,
      phase: view.phase,
      status: view.status,
      corrections: view.corrections,
      maxCorrections: view.maxCorrections,
      proofContract: view.proofContract,
      lastReview: view.lastReview,
    },
    run: { runId: snapshot.runId, status: snapshot.status, integrationCommit: snapshot.integrationCommit },
    pastDecisions,
  });
}

function decisionPrompt(role: string, view: ControllerTaskView, snapshot: TaskBatchSnapshot, instruction: string): string {
  return [
    `You are the Slopify mission controller for ticket ${view.taskId}. ${role}`,
    `Durable state (never worker transcripts): ${controllerContext(view, snapshot)}`,
    instruction,
    `You cannot modify the ticket or ignore its acceptance criteria.`,
    `End your final assistant message with exactly one standalone line:`,
    `${DECISION_MARKER}<valid JSON>`,
  ].join('\n');
}

/** Contrôleur IA à la demande : une relance en cas de réponse illisible, puis repli mécanique sûr. */
export function createLlmMissionController(options: { invoker: ControllerLlmInvoker }): MissionController {
  const invoke = async (prompt: string, snapshot: TaskBatchSnapshot): Promise<{ decision: ReturnType<typeof parseControllerDecision>; diagnostics: TaskBatchDiagnostic[] }> => {
    let diagnostics: TaskBatchDiagnostic[] = [];
    for (const attempt of [1, 2]) {
      const result = await options.invoker.invoke({ prompt, snapshot });
      diagnostics = [...diagnostics, ...result.diagnostics];
      const decision = parseControllerDecision(result.text);
      if (decision) return { decision, diagnostics };
      if (attempt === 1) {
        diagnostics.push({ code: 'controller_decision_unparsable', message: 'Controller LLM response was unparsable; retrying once.' });
        prompt += '\n\nYour previous answer contained no valid SLOPIFY_DECISION line. Reply with exactly one.';
      }
    }
    return { decision: undefined, diagnostics };
  };
  return {
    async planImplementation(view, snapshot) {
      const prompt = decisionPrompt('Define the proof contract the reviewer must satisfy.',
        view, snapshot,
        `From the ticket acceptance criteria, list the concrete proofs the reviewer must provide (for example executed tests, HTTP calls with status codes, build output).`);
      const { decision, diagnostics } = await invoke(prompt, snapshot);
      if (!decision?.proofs) {
        return {
          proofs: mechanicalProofContract(view.taskId),
          reason: 'Repli mécanique : réponse du contrôleur illisible après une relance ; contrat par défaut (rapport, tests verts, build vert).'
            + (diagnostics.length ? ` Diagnostics: ${diagnostics.map(d => `${d.code}: ${d.message}`).join('; ')}` : ''),
        };
      }
      return { proofs: decision.proofs, reason: decision.reason! };
    },
    async decideAfterReviewFailure(view, snapshot) {
      const prompt = decisionPrompt('Decide the next mission after a review FAIL.',
        view, snapshot,
        `Decide CORRECT (a targeted correction can still succeed) or STOP (the information shows a dead end).`);
      const { decision, diagnostics } = await invoke(prompt, snapshot);
      if (decision?.mission !== 'CORRECT' && decision?.mission !== 'STOP') {
        return {
          mission: 'STOP',
          reason: 'Repli sûr : réponse du contrôleur illisible après une relance ; arrêt sans nouvelle correction.'
            + (diagnostics.length ? ` Diagnostics: ${diagnostics.map(d => `${d.code}: ${d.message}`).join('; ')}` : ''),
        };
      }
      return { mission: decision.mission, reason: decision.reason! };
    },
  };
}

/** Invocation réelle via une sandbox sbx dédiée au contrôleur, sans checkpoint ni mutation du workspace.
 * Le contrôleur ne reçoit que du texte : état synthétique et décisions passées. */
export function createSbxControllerInvoker(options: {
  subprocessExecutor: SubprocessExecutor;
  agent: TaskAgent;
  storePath: string;
}): ControllerLlmInvoker {
  return {
    async invoke({ prompt, snapshot }) {
      const executor = new DockerTaskExecutor({ executor: options.subprocessExecutor });
      const attemptId = randomUUID();
      const runDirectory = path.join(options.storePath, snapshot.runId);
      const workspacePath = path.join(runDirectory, 'controller', `workspace-${attemptId}`);
      const resultDirectory = path.join(runDirectory, 'controller', 'attempts', attemptId);
      await mkdir(path.dirname(resultDirectory), { recursive: true });
      // Le contrôleur décide sur l'état durable ; il n'a besoin que d'un clone privé readonly de l'état intégré.
      const execRequest = { command: 'git', args: [] as string[], cwd: workspacePath, stdin: 'ignore' as const };
      await options.subprocessExecutor({ ...execRequest, args: ['clone', '--no-hardlinks', '--quiet', '--', snapshot.repositoryPath, workspacePath] });
      const baseCommit = snapshot.integrationCommit ?? snapshot.runBaseCommit;
      await options.subprocessExecutor({ ...execRequest, args: ['fetch', '--no-tags', snapshot.repositoryPath, `+${baseCommit}:refs/heads/slopify-controller`] }).catch(() => undefined);
      await options.subprocessExecutor({ ...execRequest, args: ['checkout', '--detach', baseCommit] });
      const result = await executor.execute({
        runId: snapshot.runId,
        taskId: 'controller',
        attemptId,
        agent: options.agent,
        workspacePath,
        specFile: snapshot.context.specFile,
        prompt,
        taskBaseCommit: baseCommit,
        runBaseCommit: snapshot.runBaseCommit,
        resultDirectory,
        mission: 'controller',
      });
      return { text: await controllerFinalText(result.reportPath), diagnostics: result.diagnostics };
    },
  };
}

async function controllerFinalText(reportPath: string | undefined): Promise<string> {
  if (!reportPath) return '';
  try { return await readFile(reportPath, 'utf8'); }
  catch { return ''; }
}
