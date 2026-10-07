import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { GitPromotion, createNodeSubprocessExecutor, type AgentCheckpointResult } from '@acp-client/sandbox';

import type {
  PipelineArtifact,
  PipelinePauseSnapshot,
  PipelineResumeDecision,
  PipelineRuntimeResult,
  PipelineRuntimeSnapshot,
  TicketGraphArtifact,
} from '@acp-client/pipeline';
import { validateMultiAgentArtifact } from '@acp-client/pipeline';

/** Constante SEQUENTIAL_DELIVERY_ARTIFACT_TYPE qui fixe un contrat partagé du pipeline. */
export const SEQUENTIAL_DELIVERY_ARTIFACT_TYPE = 'acp.sequential-delivery/v1';

const SCRATCH_REFERENCE = /`((?:\.\/)?\.scratch\/[^`\r\n]+)`/g;

/** Contrat fonctionnel de WorkspaceState dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
interface WorkspaceState {
  trackedPatch: string;
  trackedPaths: string[];
  untrackedFiles: Record<string, string>;
}

/** Contrat fonctionnel de WorkspaceRunPolicyOptions dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface WorkspaceRunPolicyOptions {
  workspaceCwd: string;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  start(pipelineName: string, prompt: string): Promise<PipelineRuntimeResult>;
  onDeliveryProgress?(message: string): void;
}

/** Contrat fonctionnel de PreparedWorkspacePause dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface PreparedWorkspacePause {
  content: string;
  error?: { code: 'invalid_workspace_handoff' | 'preimplementation_workspace_change'; message: string };
}

/** Contrat fonctionnel de WorkspaceRunPolicy dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface WorkspaceRunPolicy {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  preparePause(pause: PipelinePauseSnapshot, inspectionCwd?: string): PreparedWorkspacePause;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  complete(result: PipelineRuntimeResult, userPrompt: string): Promise<PipelineRuntimeResult>;
}

/** Composant WorkspaceRunPolicyError qui coordonne une étape observable du cycle de vie du pipeline et en préserve les invariants. */
export class WorkspaceRunPolicyError extends Error {
/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
  constructor(
    readonly code: 'invalid_sequential_delivery' | 'sequential_delivery_failed',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceRunPolicyError';
  }
}

/** Contrat fonctionnel de WorkspaceArtifact dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface WorkspaceArtifact {
  name: string;
  type: string;
  format: 'text' | 'markdown' | 'json';
  value: unknown;
  producerNodeId: string;
}

/** Contrat fonctionnel de WorkspaceRunInteraction dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface WorkspaceRunInteraction {
  id: string;
  nodeId: string;
  kind: 'question' | 'approval' | 'promotion';
  content: string;
  recommendation?: string;
  format: 'text' | 'markdown' | 'json' | 'proposed-plan';
}

/** Type métier HostInteraction utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type HostInteraction =
  | { interactionId: string; kind: 'answer'; value: string }
  | { interactionId: string; kind: 'complete-interview' }
  | { interactionId: string; kind: 'approve' }
  | { interactionId: string; kind: 'reject' };

/** Type métier WorkspaceRunOutcome utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type WorkspaceRunOutcome =
  | { status: 'completed'; runId: string; artifact?: WorkspaceArtifact }
  | { status: 'interaction-required'; runId: string; interaction: WorkspaceRunInteraction }
  | { status: 'failed'; runId: string; error: { code: string; message: string; nodeId?: string; attempt?: number } }
  | { status: 'rejected'; runId: string }
  | { status: 'cancelled'; runId: string };

/** Contrat fonctionnel de WorkspaceRun dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface WorkspaceRun {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  start(pipelineName: string, prompt: string): Promise<WorkspaceRunOutcome>;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  recover(runId: string): Promise<WorkspaceRunOutcome>;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  respond(runId: string, interaction: HostInteraction): Promise<WorkspaceRunOutcome>;
/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  cancel(runId: string): Promise<void>;
}

/** Contrat fonctionnel de WorkspaceRunBackend dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface WorkspaceRunBackend {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  start(pipelineName: string, prompt: string): Promise<PipelineRuntimeResult>;
  recover?(runId: string): Promise<PipelineRuntimeResult>;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  resume(runId: string, decision: PipelineResumeDecision): Promise<PipelineRuntimeResult>;
  cancel?(runId: string): Promise<PipelineRuntimeResult>;
}

/** Contrat fonctionnel de CreateWorkspaceRunOptions dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface CreateWorkspaceRunOptions extends WorkspaceRunPolicyOptions {
  recover?: WorkspaceRunBackend['recover'];
  resume: WorkspaceRunBackend['resume'];
  cancel?: WorkspaceRunBackend['cancel'];
}

/**
 * Adapte les transitions du runtime en interactions utilisables par l'hôte du workspace.
 * Une pause expose une question, une approbation ou une Promotion ; une Rejection et une Cancellation
 * sont rendues terminales sans appliquer de changement au workspace hôte.
 * @param options Backend de runtime, politique de livraison et callbacks de progression.
 * @returns La façade start/recover/respond/cancel du Workspace Run.
 */
export function createWorkspaceRun(options: CreateWorkspaceRunOptions): WorkspaceRun {
  const prompts = new Map<string, string>();
  const approvalValues = new Map<string, string>();
  const policy = createWorkspaceRunPolicy(options);
  const settle = async (result: PipelineRuntimeResult, prompt: string): Promise<WorkspaceRunOutcome> => {
    try {
      const delivered = await policy.complete(result, prompt);
      if (delivered.status === 'paused') {
        const preview = delivered.pause.handoff
          ? await createCheckpointInspection(options.workspaceCwd, delivered.snapshot, delivered.pause.workspaceGuard)
          : undefined;
        let prepared: PreparedWorkspacePause;
        try {
          prepared = policy.preparePause(delivered.pause, preview?.cwd);
        } finally {
          await preview?.dispose();
        }
        if (prepared.error) {
          prompts.delete(result.runId);
          approvalValues.delete(result.runId);
          return {
            status: 'failed', runId: delivered.runId,
            error: { ...prepared.error, nodeId: delivered.pause.nodeId },
          };
        }
        approvalValues.set(delivered.runId, delivered.pause.content);
        return {
          status: 'interaction-required',
          runId: delivered.runId,
          interaction: {
            id: delivered.pause.id,
            nodeId: delivered.pause.nodeId,
            kind: delivered.pause.type,
            content: prepared.content,
            ...(delivered.pause.recommendation ? { recommendation: delivered.pause.recommendation } : {}),
            format: delivered.pause.format,
          },
        };
      }
      if (delivered.status === 'completed') {
        prompts.delete(result.runId);
        approvalValues.delete(result.runId);
        return { status: 'completed', runId: delivered.runId, artifact: delivered.artifact };
      }
      if (delivered.status === 'failed') {
        prompts.delete(result.runId);
        approvalValues.delete(result.runId);
        return { status: 'failed', runId: delivered.runId, error: delivered.error };
      }
      prompts.delete(result.runId);
      approvalValues.delete(result.runId);
      if (delivered.promotion === 'rejected') {
        return { status: 'rejected', runId: delivered.runId };
      }
      return { status: 'cancelled', runId: delivered.runId };
    } catch (error: unknown) {
      prompts.delete(result.runId);
      approvalValues.delete(result.runId);
      return {
        status: 'failed', runId: result.runId,
        error: {
          code: error instanceof WorkspaceRunPolicyError ? error.code : 'workspace_run_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  };
  return {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
    async start(pipelineName, prompt) {
      const result = await options.start(pipelineName, prompt);
      prompts.set(result.runId, prompt);
      return settle(result, prompt);
    },
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
    async recover(runId) {
      if (!options.recover) throw new Error('This Workspace ACP host does not support crash recovery.');
      const result = await options.recover(runId);
      const prompt = typeof result.snapshot.inputVariables?.userPrompt === 'string'
        ? result.snapshot.inputVariables.userPrompt
        : '';
      prompts.set(result.runId, prompt);
      return settle(result, prompt);
    },
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
    async respond(runId, interaction) {
      const prompt = prompts.get(runId);
      if (prompt === undefined) throw new Error(`Unknown active Workspace ACP run "${runId}".`);
      const result = await options.resume(runId, {
        pauseId: interaction.interactionId,
        kind: interaction.kind,
        ...(interaction.kind === 'approve'
          ? { value: approvalValues.get(runId) }
          : 'value' in interaction ? { value: interaction.value } : {}),
      });
      return settle(result, prompt);
    },
/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
    async cancel(runId) {
      prompts.delete(runId);
      approvalValues.delete(runId);
      await options.cancel?.(runId);
    },
  };
}

/**
 * Définit les contrôles fonctionnels appliqués aux pauses et à la livraison séquentielle.
 * Vérifie les handoffs sous .scratch et le garde-fou documentation-only avant toute Promotion.
 * @param options Workspace et callbacks nécessaires à l'inspection et à la livraison.
 * @returns Une politique qui prépare les pauses et finalise les artefacts de livraison.
 */
export function createWorkspaceRunPolicy(options: WorkspaceRunPolicyOptions): WorkspaceRunPolicy {
  const baseline = captureWorkspaceState(options.workspaceCwd);
  return {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
    preparePause(pause, inspectionCwd = options.workspaceCwd) {
      const content = expandWorkspaceMarkdownReferences(inspectionCwd, pause.content);
      if (pause.handoff) {
        const handoffError = validateWorkspaceHandoff(inspectionCwd, pause.content, pause.handoff);
        if (handoffError) {
          return { content, error: { code: 'invalid_workspace_handoff', message: handoffError } };
        }
      }
      if (pause.workspaceGuard === 'documentation-only') {
        const guardError = validateWorkspaceState(baseline, captureWorkspaceState(options.workspaceCwd));
        if (guardError) {
          return { content, error: { code: 'preimplementation_workspace_change', message: guardError } };
        }
      }
      return { content };
    },
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
    async complete(result, userPrompt) {
      if (result.status !== 'completed' || result.artifact?.type !== SEQUENTIAL_DELIVERY_ARTIFACT_TYPE) {
        return result;
      }
      let plan;
      try {
        plan = prepareSequentialDelivery(options.workspaceCwd, result);
      } catch (error: unknown) {
        throw new WorkspaceRunPolicyError('invalid_sequential_delivery', error instanceof Error ? error.message : String(error));
      }
      try {
        for (const [index, ticket] of plan.tickets.entries()) {
          options.onDeliveryProgress?.(`Starting ticket ${index + 1}/${plan.tickets.length}: ${ticket.id}`);
          const ticketResult = await options.start('implement-ticket', [
            'User request:', userPrompt, '',
            `Specification: \`${plan.specificationPath}\``,
            `Ticket ID: ${ticket.id}`,
            `Dependencies: ${ticket.needs.length > 0 ? ticket.needs.join(', ') : 'None'}`,
            `Ticket Graph node:\n${JSON.stringify(ticket.node, null, 2)}`,
            `Human-readable ticket: \`${ticket.markdownPath}\``,
          ].join('\n'));
          if (ticketResult.status === 'paused') {
            throw new Error(`implement-ticket paused unexpectedly at node "${ticketResult.pause.nodeId}".`);
          }
          if (ticketResult.status !== 'completed') return ticketResult;
        }
        options.onDeliveryProgress?.(`Completed ${plan.tickets.length} ticket pipeline(s); starting review.`);
        const review = await options.start('review-delivery', [
          'User request:', userPrompt, '', 'Approved delivery files:',
          `- \`${plan.specificationPath}\``, `- \`${plan.issuesDirectory}/\``,
        ].join('\n'));
        if (review.status === 'paused') {
          throw new Error(`review-delivery paused unexpectedly at node "${review.pause.nodeId}".`);
        }
        return review;
      } catch (error: unknown) {
        throw new WorkspaceRunPolicyError('sequential_delivery_failed', error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/** Inspecte la livraison isolée intégrée ; l'approbation ne doit pas modifier l'hôte. */
async function createCheckpointInspection(
  workspaceCwd: string,
  snapshot: PipelineRuntimeSnapshot,
  guard: PipelinePauseSnapshot['workspaceGuard'],
): Promise<{ cwd: string; dispose(): Promise<void> } | undefined> {
  const selected = new Map<string, AgentCheckpointResult>();
  for (const state of Object.values(snapshot.sandboxRuns ?? {})) {
    if (!state.checkpoint) continue;
    const previous = selected.get(state.nodeId);
    if (previous && previous.checkpoint.attempt > state.attempt) continue;
    selected.set(state.nodeId, {
      checkpointStatus: state.checkpoint.status,
      checkpoint: { runId: state.runId, nodeId: state.nodeId, attempt: state.attempt,
        sandboxName: state.sandboxName, baseCommit: state.baseCommit, commit: state.checkpoint.commit,
        remote: state.checkpoint.remote, ref: state.checkpoint.ref },
      preview: state.checkpoint.preview,
    });
  }
  if (!selected.size) return undefined;
  const execute = createNodeSubprocessExecutor();
  const composed = await new GitPromotion(execute).integrateAgentCheckpoints({
    workspaceCwd, runId: snapshot.runId, checkpoints: [...selected.values()],
  });
  if (guard === 'documentation-only') {
    const invalid = composed.preview.files.filter(file => !isWorkspaceGuardAllowedPath(file));
    if (invalid.length) throw new Error(`Documentation-only checkpoints changed implementation files: ${invalid.join(', ')}`);
  }
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'slopify-inspection-'));
  const cwd = path.join(directory, 'workspace');
  const dispose = async () => {
    const result = await execute({ command: 'git', args: ['worktree', 'remove', '--force', cwd], cwd: workspaceCwd, stdin: 'ignore' });
    if (result.exitCode !== 0) throw new Error(`Unable to remove delivery inspection worktree: ${result.stderr}`);
    fs.rmSync(directory, { recursive: true, force: true });
  };
  const added = await execute({ command: 'git', args: ['worktree', 'add', '--detach', cwd, composed.changeSet.commit], cwd: workspaceCwd, stdin: 'ignore' });
  if (added.exitCode !== 0) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw new Error(`Unable to inspect isolated delivery: ${added.stderr}`);
  }
  return { cwd, dispose };
}

/** Point d'entrée validateWorkspaceHandoff du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function validateWorkspaceHandoff(
  workspaceCwd: string,
  content: string,
  handoff: NonNullable<PipelinePauseSnapshot['handoff']>,
): string | undefined {
  const references = collectScratchReferences(content);
  const validTargets = new Set<string>();
  for (const reference of references) {
    const normalized = normalizeReference(reference);
    const scratchRoot = path.resolve(workspaceCwd, '.scratch');
    const target = path.resolve(workspaceCwd, normalized);
    if (!isChildPath(scratchRoot, target)) return `Workspace handoff path escapes .scratch: ${reference}`;
    if (!fs.existsSync(target)) return `Workspace handoff path does not exist: ${reference}`;
    const stat = fs.statSync(target);
    if (stat.isFile()) {
      if (!target.endsWith('.md')) return `Workspace handoff file is not Markdown: ${reference}`;
      validTargets.add(target);
    } else if (stat.isDirectory()) {
      if (!fs.readdirSync(target, { withFileTypes: true }).some(entry => entry.isFile() && entry.name.endsWith('.md'))) {
        return `Workspace handoff directory contains no Markdown files: ${reference}`;
      }
      validTargets.add(target);
    } else {
      return `Workspace handoff path is neither a Markdown file nor a directory: ${reference}`;
    }
  }
  const required = handoff.minimumReferences ?? 1;
  if (validTargets.size < required) {
    return `Workspace handoff requires at least ${required} existing .scratch Markdown reference(s), but found ${validTargets.size}.`;
  }
  return handoff.layout === 'delivery' ? validateDeliveryLayout(references) : undefined;
}

/** Point d'entrée validateDeliveryLayout du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function validateDeliveryLayout(references: string[]): string | undefined {
  const normalized = [...new Set(references.map(normalizeReference))];
  const roots = new Set(normalized.map(featureRoot).filter((value): value is string => Boolean(value)));
  if (roots.size !== 1) return `Workspace handoff must preserve one feature directory, but found ${roots.size}.`;
  const [root] = [...roots];
  if (normalized.some(reference => featureRoot(reference) !== root)) {
    return 'Workspace handoff contains references outside the preserved feature directory.';
  }
  if (!normalized.includes(`${root}/spec.md`)) return `Delivery handoff must reference the specification: ${root}/spec.md`;
  if (!normalized.includes(`${root}/issues`)) return `Delivery handoff must reference the ticket directory: ${root}/issues/`;
  return undefined;
}

/** Point d'entrée expandWorkspaceMarkdownReferences du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function expandWorkspaceMarkdownReferences(workspaceCwd: string, content: string): string {
  const files = collectReferencedMarkdownFiles(workspaceCwd, content);
  if (files.length === 0) return content;
  return [content.trimEnd(), '## Workspace documents', ...files.map(file =>
    `### \`${toWorkspacePath(workspaceCwd, file)}\`\n\n${fs.readFileSync(file, 'utf8').trim()}`,
  )].join('\n\n');
}

/** Point d'entrée prepareSequentialDelivery du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function prepareSequentialDelivery(workspaceCwd: string, result: Extract<PipelineRuntimeResult, { status: 'completed' }>) {
  const artifact = result.artifact;
  if (!artifact) throw new Error('Sequential delivery result must contain a handoff artifact.');
  if (typeof artifact.value !== 'string') throw new Error('Sequential delivery artifact must contain a Markdown handoff string.');
  const references = collectScratchReferences(artifact.value).map(normalizeReference);
  const specs = [...new Set(references.filter(reference => /\/spec\.md$/.test(reference)))];
  const issueDirs = [...new Set(references.filter(reference => /\/issues$/.test(reference)))];
  if (specs.length !== 1) throw new Error(`Sequential delivery requires exactly one specification path, found ${specs.length}.`);
  if (issueDirs.length !== 1) throw new Error(`Sequential delivery requires exactly one issues directory, found ${issueDirs.length}.`);
  const specificationPath = specs[0];
  const issuesDirectory = issueDirs[0];
  if (featureRoot(specificationPath) !== featureRoot(`${issuesDirectory}/placeholder.md`)) {
    throw new Error('Sequential delivery specification and issues directory must share one feature root.');
  }
  const specificationAbsolute = resolveScratchPath(workspaceCwd, specificationPath);
  const issuesAbsolute = resolveScratchPath(workspaceCwd, issuesDirectory);
  if (!fs.statSync(specificationAbsolute).isFile()) throw new Error(`Sequential delivery specification is not a file: ${specificationPath}`);
  if (!fs.statSync(issuesAbsolute).isDirectory()) throw new Error(`Sequential delivery issues path is not a directory: ${issuesDirectory}`);
  const ticketGraph = readTicketGraph(result);
  const markdownByTicketId = indexTicketMarkdown(issuesAbsolute, issuesDirectory);
  const tickets = orderTicketsByDependencies(ticketGraph.tickets).map(ticket => {
    const markdownPath = markdownByTicketId.get(ticket.id);
    if (!markdownPath) throw new Error(`Ticket Graph node "${ticket.id}" has no Markdown adapter in ${issuesDirectory}.`);
    return { id: ticket.id, needs: ticket.needs, node: ticket, markdownPath };
  });
  return { specificationPath, issuesDirectory, tickets };
}

/** Point d'entrée orderTicketsByDependencies du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function orderTicketsByDependencies(tickets: TicketGraphArtifact['tickets']): TicketGraphArtifact['tickets'] {
  const remaining = [...tickets];
  const completed = new Set<string>();
  const ordered: TicketGraphArtifact['tickets'] = [];
  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex(ticket => ticket.needs.every(need => completed.has(need)));
    if (readyIndex < 0) {
      throw new Error(`Ticket Graph dependencies cannot be satisfied for: ${remaining.map(ticket => ticket.id).join(', ')}.`);
    }
    const [ready] = remaining.splice(readyIndex, 1);
    ordered.push(ready);
    completed.add(ready.id);
  }
  return ordered;
}

/** Point d'entrée readTicketGraph du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function readTicketGraph(result: Extract<PipelineRuntimeResult, { status: 'completed' }>): TicketGraphArtifact {
  const artifact = Object.values(result.snapshot.artifacts).reverse()
    .find(candidate => candidate.type === 'acp.ticket-graph/v1');
  if (!artifact) throw new Error('Sequential delivery requires an acp.ticket-graph/v1 artifact in the run snapshot.');
  const validation = validateMultiAgentArtifact('acp.ticket-graph/v1', artifact.value);
  if (!validation.ok || validation.value?.contract !== 'acp.ticket-graph/v1') {
    throw new Error(`Invalid Ticket Graph: ${validation.errors.join(' ')}`);
  }
  return validation.value;
}

/** Point d'entrée indexTicketMarkdown du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function indexTicketMarkdown(issuesAbsolute: string, issuesDirectory: string): Map<string, string> {
  const indexed = new Map<string, string>();
  for (const entry of fs.readdirSync(issuesAbsolute, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const matches = [...fs.readFileSync(path.join(issuesAbsolute, entry.name), 'utf8').matchAll(/^\*\*Ticket ID:\*\*\s*(\S+)\s*$/gm)];
    if (matches.length !== 1) continue;
    const id = matches[0][1];
    if (indexed.has(id)) throw new Error(`Markdown adapter duplicates Ticket Graph node "${id}".`);
    indexed.set(id, `${issuesDirectory}/${entry.name}`);
  }
  return indexed;
}

/** Point d'entrée collectScratchReferences du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function collectScratchReferences(content: string): string[] {
  return [...content.matchAll(SCRATCH_REFERENCE)].map(match => match[1]);
}

/** Point d'entrée collectReferencedMarkdownFiles du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function collectReferencedMarkdownFiles(workspaceCwd: string, content: string): string[] {
  const scratchRoot = path.resolve(workspaceCwd, '.scratch');
  const files = new Set<string>();
  for (const reference of collectScratchReferences(content)) {
    const target = path.resolve(workspaceCwd, normalizeReference(reference));
    if (!isChildPath(scratchRoot, target) || !fs.existsSync(target)) continue;
    const stat = fs.statSync(target);
    if (stat.isFile() && target.endsWith('.md')) files.add(target);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md')) files.add(path.join(target, entry.name));
      }
    }
  }
  return [...files].sort();
}

/** Point d'entrée normalizeReference du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function normalizeReference(reference: string): string {
  return reference.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

/** Point d'entrée featureRoot du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function featureRoot(reference: string): string | undefined {
  return /^(\.scratch\/[^/]+)\/.+$/.exec(reference)?.[1];
}

/** Point d'entrée resolveScratchPath du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function resolveScratchPath(workspaceCwd: string, workspacePath: string): string {
  const target = path.resolve(workspaceCwd, workspacePath);
  if (!isChildPath(path.resolve(workspaceCwd, '.scratch'), target)) throw new Error(`Sequential delivery path escapes .scratch: ${workspacePath}`);
  if (!fs.existsSync(target)) throw new Error(`Sequential delivery path does not exist: ${workspacePath}`);
  return target;
}

/** Point d'entrée isChildPath du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function isChildPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Point d'entrée toWorkspacePath du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function toWorkspacePath(workspaceCwd: string, file: string): string {
  return path.relative(workspaceCwd, file).split(path.sep).join('/');
}

/** Point d'entrée captureWorkspaceState du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function captureWorkspaceState(workspaceCwd: string): WorkspaceState | undefined {
  try {
    if (runGit(workspaceCwd, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') return undefined;
    const exclusions = [
      ':(exclude).scratch/**',
      ':(exclude).acp/runs-v3/**',
      ':(exclude)CONTEXT.md',
      ':(exclude)docs/architecture/adr/**',
    ];
    const trackedPatch = runGit(workspaceCwd, ['diff', '--binary', 'HEAD', '--', '.', ...exclusions]);
    const trackedPaths = splitLines(runGit(workspaceCwd, ['diff', '--name-only', 'HEAD', '--', '.', ...exclusions]));
    const untrackedFiles = Object.fromEntries(runGit(workspaceCwd, ['ls-files', '--others', '--exclude-standard', '-z'])
      .split('\0').filter(Boolean).map(value => value.split(path.sep).join('/')).filter(file => !isWorkspaceGuardAllowedPath(file)).sort()
      .map(file => [file, fingerprintPath(path.join(workspaceCwd, file))]));
    return { trackedPatch, trackedPaths, untrackedFiles };
  } catch { return undefined; }
}

/** Point d'entrée validateWorkspaceState du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function validateWorkspaceState(before: WorkspaceState | undefined, after: WorkspaceState | undefined): string | undefined {
  if (!before || !after || (before.trackedPatch === after.trackedPatch && JSON.stringify(before.untrackedFiles) === JSON.stringify(after.untrackedFiles))) return undefined;
  const untracked = new Set([...Object.keys(before.untrackedFiles), ...Object.keys(after.untrackedFiles)]);
  const changed = [...untracked].filter(file => before.untrackedFiles[file] !== after.untrackedFiles[file]);
  const paths = [...new Set([...after.trackedPaths, ...changed])].sort();
  return `Documentation-only nodes changed workspace files outside .scratch, CONTEXT.md, or docs/architecture/adr/${paths.length ? `: ${paths.join(', ')}` : ''}`;
}

/** Point d'entrée runGit du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Point d'entrée splitLines du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function splitLines(value: string): string[] { return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean); }
/** Point d'entrée isWorkspaceGuardAllowedPath du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function isWorkspaceGuardAllowedPath(file: string): boolean {
  return file === 'CONTEXT.md' || file === '.scratch' || file.startsWith('.scratch/')
    || file === '.acp/runs-v3' || file.startsWith('.acp/runs-v3/')
    || file === 'docs/architecture/adr' || file.startsWith('docs/architecture/adr/');
}
/** Point d'entrée fingerprintPath du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function fingerprintPath(file: string): string {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return createHash('sha256').update(`link:${fs.readlinkSync(file)}`).digest('hex');
  if (stat.isFile()) return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return createHash('sha256').update(`mode:${stat.mode}:size:${stat.size}`).digest('hex');
}
