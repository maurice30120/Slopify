import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  PipelineArtifact,
  PipelinePauseSnapshot,
  PipelineResumeDecision,
  PipelineRuntimeResult,
  TicketGraphArtifact,
} from '@acp-client/pipeline';
import { validateMultiAgentArtifact } from '@acp-client/pipeline';

export const SEQUENTIAL_DELIVERY_ARTIFACT_TYPE = 'acp.sequential-delivery/v1';

const SCRATCH_REFERENCE = /`((?:\.\/)?\.scratch\/[^`\r\n]+)`/g;

interface WorkspaceState {
  files: Record<string, string>;
}

export interface WorkspaceRunPolicyOptions {
  workspaceCwd: string;
  start(pipelineName: string, prompt: string): Promise<PipelineRuntimeResult>;
  onDeliveryProgress?(message: string): void;
}

export interface PreparedWorkspacePause {
  content: string;
  error?: { code: 'invalid_workspace_handoff' | 'preimplementation_workspace_change'; message: string };
}

export interface WorkspaceRunPolicy {
  preparePause(pause: PipelinePauseSnapshot): PreparedWorkspacePause;
  complete(result: PipelineRuntimeResult, userPrompt: string): Promise<PipelineRuntimeResult>;
}

export class WorkspaceRunPolicyError extends Error {
  constructor(
    readonly code: 'invalid_sequential_delivery' | 'sequential_delivery_failed',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceRunPolicyError';
  }
}

export interface WorkspaceArtifact {
  name: string;
  type: string;
  format: 'text' | 'markdown' | 'json';
  value: unknown;
  producerNodeId: string;
}

export interface WorkspaceRunInteraction {
  id: string;
  nodeId: string;
  kind: 'question' | 'approval' | 'promotion';
  content: string;
  recommendation?: string;
  format: 'text' | 'markdown' | 'json' | 'proposed-plan';
}

export type HostInteraction =
  | { interactionId: string; kind: 'answer'; value: string }
  | { interactionId: string; kind: 'complete-interview' }
  | { interactionId: string; kind: 'approve' }
  | { interactionId: string; kind: 'reject' };

export type WorkspaceRunOutcome =
  | { status: 'completed'; runId: string; artifact?: WorkspaceArtifact }
  | { status: 'interaction-required'; runId: string; interaction: WorkspaceRunInteraction }
  | { status: 'failed'; runId: string; error: { code: string; message: string; nodeId?: string; attempt?: number } }
  | { status: 'rejected'; runId: string }
  | { status: 'cancelled'; runId: string };

export interface WorkspaceRun {
  start(pipelineName: string, prompt: string): Promise<WorkspaceRunOutcome>;
  recover(runId: string): Promise<WorkspaceRunOutcome>;
  respond(runId: string, interaction: HostInteraction): Promise<WorkspaceRunOutcome>;
  cancel(runId: string): Promise<void>;
}

export interface WorkspaceRunBackend {
  start(pipelineName: string, prompt: string): Promise<PipelineRuntimeResult>;
  recover?(runId: string): Promise<PipelineRuntimeResult>;
  resume(runId: string, decision: PipelineResumeDecision): Promise<PipelineRuntimeResult>;
  cancel?(runId: string): Promise<PipelineRuntimeResult>;
}

export interface CreateWorkspaceRunOptions extends WorkspaceRunPolicyOptions {
  recover?: WorkspaceRunBackend['recover'];
  resume: WorkspaceRunBackend['resume'];
  cancel?: WorkspaceRunBackend['cancel'];
}

export function createWorkspaceRun(options: CreateWorkspaceRunOptions): WorkspaceRun {
  const prompts = new Map<string, string>();
  const approvalValues = new Map<string, string>();
  const policy = createWorkspaceRunPolicy(options);
  const settle = async (result: PipelineRuntimeResult, prompt: string): Promise<WorkspaceRunOutcome> => {
    try {
      const delivered = await policy.complete(result, prompt);
      if (delivered.status === 'paused') {
        const prepared = policy.preparePause(delivered.pause);
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
    async start(pipelineName, prompt) {
      const result = await options.start(pipelineName, prompt);
      prompts.set(result.runId, prompt);
      return settle(result, prompt);
    },
    async recover(runId) {
      if (!options.recover) throw new Error('This Workspace ACP host does not support crash recovery.');
      const result = await options.recover(runId);
      const prompt = typeof result.snapshot.inputVariables?.userPrompt === 'string'
        ? result.snapshot.inputVariables.userPrompt
        : '';
      prompts.set(result.runId, prompt);
      return settle(result, prompt);
    },
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
    async cancel(runId) {
      prompts.delete(runId);
      approvalValues.delete(runId);
      await options.cancel?.(runId);
    },
  };
}

export function createWorkspaceRunPolicy(options: WorkspaceRunPolicyOptions): WorkspaceRunPolicy {
  const baseline = captureWorkspaceState(options.workspaceCwd);
  return {
    preparePause(pause) {
      const content = expandWorkspaceMarkdownReferences(options.workspaceCwd, pause.content);
      if (pause.handoff) {
        // Les nœuds documentaires s'exécutent dans des Sandboxes séparées :
        // leurs fichiers n'entrent dans le workspace hôte qu'après
        // l'approbation, lors de la Promotion du pipeline. Vérifier la forme
        // du handoff maintenant, mais différer l'existence des cibles jusqu'à
        // la préparation de la livraison.
        const requireExistingTargets = pause.workspaceGuard !== 'documentation-only'
          || pause.handoff.layout !== 'delivery';
        const handoffError = validateWorkspaceHandoff(
          options.workspaceCwd,
          pause.content,
          pause.handoff,
          requireExistingTargets,
        );
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

function validateWorkspaceHandoff(
  workspaceCwd: string,
  content: string,
  handoff: NonNullable<PipelinePauseSnapshot['handoff']>,
  requireExistingTargets = true,
): string | undefined {
  const references = collectScratchReferences(content);
  const validTargets = new Set<string>();
  for (const reference of references) {
    const normalized = normalizeReference(reference);
    const scratchRoot = path.resolve(workspaceCwd, '.scratch');
    const target = path.resolve(workspaceCwd, normalized);
    if (!isChildPath(scratchRoot, target)) return `Workspace handoff path escapes .scratch: ${reference}`;
    if (!fs.existsSync(target)) {
      if (requireExistingTargets) return `Workspace handoff path does not exist: ${reference}`;
      continue;
    }
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
  const targetCount = requireExistingTargets ? validTargets.size : new Set(references.map(normalizeReference)).size;
  if (targetCount < required) {
    return `Workspace handoff requires at least ${required} existing .scratch Markdown reference(s), but found ${validTargets.size}.`;
  }
  return handoff.layout === 'delivery' ? validateDeliveryLayout(references) : undefined;
}

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

function expandWorkspaceMarkdownReferences(workspaceCwd: string, content: string): string {
  const files = collectReferencedMarkdownFiles(workspaceCwd, content);
  if (files.length === 0) return content;
  return [content.trimEnd(), '## Workspace documents', ...files.map(file =>
    `### \`${toWorkspacePath(workspaceCwd, file)}\`\n\n${fs.readFileSync(file, 'utf8').trim()}`,
  )].join('\n\n');
}

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
  const ticketGraph = readTicketGraph(workspaceCwd, result);
  const markdownByTicketId = indexTicketMarkdown(issuesAbsolute, issuesDirectory);
  const tickets = orderTicketsByDependencies(ticketGraph.tickets).map(ticket => {
    const markdownPath = markdownByTicketId.get(ticket.id);
    if (!markdownPath) throw new Error(`Ticket Graph node "${ticket.id}" has no Markdown adapter in ${issuesDirectory}.`);
    return { id: ticket.id, needs: ticket.needs, node: ticket, markdownPath };
  });
  return { specificationPath, issuesDirectory, tickets };
}

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

function readTicketGraph(
  workspaceCwd: string,
  result: Extract<PipelineRuntimeResult, { status: 'completed' }>,
): TicketGraphArtifact {
  const artifacts = Object.values(result.snapshot.artifacts).reverse();
  let artifact = artifacts
    .find(candidate => candidate.type === 'acp.ticket-graph/v1');
  if (!artifact) {
    const ticketsHandoff = artifacts.find(candidate =>
      candidate.type === 'acp.workspace-files/v1'
      && typeof candidate.value === 'string'
      && collectScratchReferences(candidate.value).some(reference => /\/issues\/?$/.test(reference)),
    );
    artifact = ticketsHandoff
      ? synthesizeTicketGraphArtifact(workspaceCwd, ticketsHandoff) ?? undefined
      : undefined;
  }
  if (!artifact) throw new Error('Sequential delivery requires an acp.ticket-graph/v1 artifact in the run snapshot.');
  const validation = validateMultiAgentArtifact('acp.ticket-graph/v1', artifact.value);
  if (!validation.ok || validation.value?.contract !== 'acp.ticket-graph/v1') {
    throw new Error(`Invalid Ticket Graph: ${validation.errors.join(' ')}`);
  }
  return validation.value;
}

/**
 * Synthétise un artefact `acp.ticket-graph/v1` (JSON) à partir des tickets
 * Markdown écrits par un nœud agent `acp.workspace-files/v1`. Le planner écrit
 * un fichier Markdown par ticket sous `.scratch/<feature>/issues/` et renvoie un
 * handoff Markdown pointant vers ce répertoire ; cet adaptateur reconstruit le
 * graphe structuré obligatoire attendu par la livraison séquentielle.
 *
 * Retourne `null` lorsque l'artefact n'est pas un handoff `workspace-files`
 * référençant un répertoire `issues/` (aucune synthèse possible).
 */
export function synthesizeTicketGraphArtifact(
  workspaceCwd: string,
  artifact: PipelineArtifact,
): PipelineArtifact | null {
  if (artifact.type !== 'acp.workspace-files/v1' || typeof artifact.value !== 'string') return null;
  const references = collectScratchReferences(artifact.value).map(normalizeReference);
  const issueDirs = [...new Set(references.filter(reference => /\/issues$/.test(reference)))];
  if (issueDirs.length !== 1) return null;
  const issuesAbsolute = path.resolve(workspaceCwd, issueDirs[0]);
  if (!isChildPath(path.resolve(workspaceCwd, '.scratch'), issuesAbsolute)) {
    throw new Error(`Sequential delivery path escapes .scratch: ${issueDirs[0]}`);
  }
  if (!fs.existsSync(issuesAbsolute)) return null;
  if (!fs.statSync(issuesAbsolute).isDirectory()) return null;
  const derived = deriveTicketGraphFromIssues(issuesAbsolute);
  const validation = validateMultiAgentArtifact('acp.ticket-graph/v1', derived);
  if (!validation.ok || validation.value?.contract !== 'acp.ticket-graph/v1') {
    throw new Error(`Invalid Ticket Graph synthesized from ${issueDirs[0]}: ${validation.errors.join(' ')}`);
  }
  return {
    name: 'ticketGraph',
    type: 'acp.ticket-graph/v1',
    format: 'json',
    value: validation.value,
    producerNodeId: artifact.producerNodeId,
  };
}

function indexTicketMarkdown(issuesAbsolute: string, issuesDirectory: string): Map<string, string> {
  const indexed = new Map<string, string>();
  for (const entry of fs.readdirSync(issuesAbsolute, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const id = readTicketId(fs.readFileSync(path.join(issuesAbsolute, entry.name), 'utf8'), entry.name);
    if (!id) continue;
    if (indexed.has(id)) throw new Error(`Markdown adapter duplicates Ticket Graph node "${id}".`);
    indexed.set(id, `${issuesDirectory}/${entry.name}`);
  }
  return indexed;
}

const TICKET_ID_PATTERN = /^\*\*Ticket ID:\*\*\s*(\S+)\s*$/m;
const BLOCKED_BY_PATTERN = /^\*\*Blocked by:\*\*\s*(.+?)\s*$/m;
const WHAT_TO_BUILD_PATTERN = /^\*\*What to build:\*\*\s*(.+?)\s*$/m;
const HEADING_PATTERN = /^\s*#\s+(.+?)\s*$/m;
const ID_TOKEN_PATTERN = /^(T?\d+)/;

function deriveTicketGraphFromIssues(issuesAbsolute: string): TicketGraphArtifact {
  const entries = fs.readdirSync(issuesAbsolute, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (entries.length === 0) {
    throw new Error(`Sequential delivery issues directory contains no Markdown tickets: ${issuesAbsolute}`);
  }
  const files = entries.map(entry => ({
    name: entry.name,
    text: fs.readFileSync(path.join(issuesAbsolute, entry.name), 'utf8'),
  }));
  const byId = new Map<string, { name: string; text: string; title: string }>();
  for (const file of files) {
    const id = readTicketId(file.text, file.name);
    if (!id) throw new Error(`Sequential delivery ticket "${file.name}" has no stable Ticket ID.`);
    if (byId.has(id)) throw new Error(`Sequential delivery ticket "${file.name}" duplicates Ticket Graph node "${id}".`);
    byId.set(id, { name: file.name, text: file.text, title: readTicketTitle(file.text, file.name) || id });
  }
  const ids = new Set(byId.keys());
  const tickets: TicketGraphArtifact['tickets'] = [];
  for (const [id, file] of byId) {
    tickets.push({
      id,
      title: file.title,
      scope: readTicketScope(file.text, file.title),
      needs: readTicketNeeds(file.text, ids),
      validation: readTicketValidation(file.text, file.title),
    });
  }
  return { contract: 'acp.ticket-graph/v1', tickets };
}

function readTicketId(text: string, name: string): string | undefined {
  const explicit = TICKET_ID_PATTERN.exec(text)?.[1];
  if (explicit) return explicit;
  const heading = HEADING_PATTERN.exec(text)?.[1] ?? '';
  const headingToken = ID_TOKEN_PATTERN.exec(heading)?.[1];
  if (headingToken) return headingToken;
  return ID_TOKEN_PATTERN.exec(name.replace(/\.md$/, ''))?.[1];
}

function readTicketTitle(text: string, name: string): string {
  const heading = HEADING_PATTERN.exec(text)?.[1] ?? '';
  const stripped = heading.replace(ID_TOKEN_PATTERN, '').replace(/^[:—–\-\s]+/, '').trim();
  if (stripped) return stripped;
  return name.replace(/\.md$/, '').replace(/^[T\d]*[-:—–\s]*/, '').trim() || name.replace(/\.md$/, '');
}

function readTicketScope(text: string, title: string): string[] {
  const match = WHAT_TO_BUILD_PATTERN.exec(text)?.[1];
  if (match && match.trim()) return [match.trim()];
  return [title];
}

function readTicketNeeds(text: string, ids: Set<string>): string[] {
  const match = BLOCKED_BY_PATTERN.exec(text)?.[1];
  if (!match || /^\s*none\b/i.test(match)) return [];
  const needs: string[] = [];
  for (const part of match.split(/,|;|\band\b/).map(part => part.trim()).filter(Boolean)) {
    if (/^\s*none\b/i.test(part)) continue;
    const token = ID_TOKEN_PATTERN.exec(part)?.[1];
    if (token && ids.has(token)) needs.push(token);
  }
  return [...new Set(needs)];
}

function readTicketValidation(text: string, title: string): string[] {
  const items = [...text.matchAll(/^\s*-\s*\[[ xX]\]\s+(.+?)\s*$/gm)].map(match => match[1]).filter(Boolean);
  return items.length > 0 ? items : [`${title} delivered`];
}

function collectScratchReferences(content: string): string[] {
  return [...content.matchAll(SCRATCH_REFERENCE)].map(match => match[1]);
}

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

function normalizeReference(reference: string): string {
  return reference.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function featureRoot(reference: string): string | undefined {
  // Inline workspace-file handoffs may mention the feature directory itself;
  // treat that root reference the same as one of its descendants.
  return /^(\.scratch\/[^/]+)(?:\/.*)?$/.exec(reference)?.[1];
}

function resolveScratchPath(workspaceCwd: string, workspacePath: string): string {
  const target = path.resolve(workspaceCwd, workspacePath);
  if (!isChildPath(path.resolve(workspaceCwd, '.scratch'), target)) throw new Error(`Sequential delivery path escapes .scratch: ${workspacePath}`);
  if (!fs.existsSync(target)) throw new Error(`Sequential delivery path does not exist: ${workspacePath}`);
  return target;
}

function isChildPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toWorkspacePath(workspaceCwd: string, file: string): string {
  return path.relative(workspaceCwd, file).split(path.sep).join('/');
}

function captureWorkspaceState(workspaceCwd: string): WorkspaceState | undefined {
  try {
    if (runGit(workspaceCwd, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') return undefined;
    // Snapshot file contents, including existing local edits, so HEAD-relative changes
    // cannot implicate untouched dirty files or hide files restored during the run.
    const paths = runGit(workspaceCwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
      .split('\0').filter(Boolean).filter(file => !isWorkspaceGuardAllowedPath(file));
    const files = Object.fromEntries([...new Set(paths)].sort().flatMap(file => {
      try { return [[file, fingerprintPath(path.join(workspaceCwd, file))]]; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    }));
    return { files };
  } catch { return undefined; }
}

function validateWorkspaceState(before: WorkspaceState | undefined, after: WorkspaceState | undefined): string | undefined {
  if (!before || !after) return undefined;
  const paths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter(file => before.files[file] !== after.files[file]).sort();
  if (paths.length === 0) return undefined;
  const changes = paths.map(file => {
    const status = !(file in before.files) ? 'added' : !(file in after.files) ? 'deleted' : 'modified';
    return `  - ${status}: ${JSON.stringify(file)}`;
  });
  return [
    `Documentation-only workspace guard: ${paths.length} file(s) changed since the run started outside the allowed paths.`,
    'Allowed paths: .scratch/, CONTEXT.md, docs/architecture/adr/, .acp/runs-v3/ (run state).',
    'Existing uncommitted changes that stayed unchanged are not listed.',
    ...changes,
    'These changes may come from agents or concurrent edits; this check cannot identify their author.',
    'Review the listed files before retrying. A dirty workspace alone does not cause this failure.',
  ].join('\n');
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function isWorkspaceGuardAllowedPath(file: string): boolean {
  return file === 'CONTEXT.md' || file === '.scratch' || file.startsWith('.scratch/')
    || file === '.acp/runs-v3' || file.startsWith('.acp/runs-v3/')
    || file === 'docs/architecture/adr' || file.startsWith('docs/architecture/adr/');
}
function fingerprintPath(file: string): string {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return createHash('sha256').update(`link:${fs.readlinkSync(file)}`).digest('hex');
  if (stat.isFile()) return createHash('sha256').update(`file:${stat.mode}:`).update(fs.readFileSync(file)).digest('hex');
  return createHash('sha256').update(`mode:${stat.mode}:size:${stat.size}`).digest('hex');
}
