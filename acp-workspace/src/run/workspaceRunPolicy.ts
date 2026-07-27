import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  PipelineArtifact,
  PipelinePauseSnapshot,
  PipelineResumeDecision,
  PipelineRuntimeResult,
} from '@acp-client/pipeline';

export const SEQUENTIAL_DELIVERY_ARTIFACT_TYPE = 'acp.sequential-delivery/v1';

const SCRATCH_REFERENCE = /`((?:\.\/)?\.scratch\/[^`\r\n]+)`/g;

interface WorkspaceState {
  trackedPatch: string;
  trackedPaths: string[];
  untrackedFiles: Record<string, string>;
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
        const handoffError = validateWorkspaceHandoff(options.workspaceCwd, pause.content, pause.handoff);
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
        plan = prepareSequentialDelivery(options.workspaceCwd, result.artifact);
      } catch (error: unknown) {
        throw new WorkspaceRunPolicyError('invalid_sequential_delivery', error instanceof Error ? error.message : String(error));
      }
      try {
        for (const [index, ticketPath] of plan.ticketPaths.entries()) {
          options.onDeliveryProgress?.(`Starting ticket ${index + 1}/${plan.ticketPaths.length}: ${ticketPath}`);
          const ticketResult = await options.start('implement-ticket', [
            'User request:', userPrompt, '',
            `Specification: \`${plan.specificationPath}\``,
            `Ticket: \`${ticketPath}\``,
          ].join('\n'));
          if (ticketResult.status === 'paused') {
            throw new Error(`implement-ticket paused unexpectedly at node "${ticketResult.pause.nodeId}".`);
          }
          if (ticketResult.status !== 'completed') return ticketResult;
        }
        options.onDeliveryProgress?.(`Completed ${plan.ticketPaths.length} ticket pipeline(s); starting review.`);
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

function prepareSequentialDelivery(workspaceCwd: string, artifact: PipelineArtifact) {
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
  const ticketNames = fs.readdirSync(issuesAbsolute, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(entry => entry.name).sort();
  if (ticketNames.length === 0) throw new Error(`Sequential delivery issues directory contains no Markdown tickets: ${issuesDirectory}`);
  for (const [index, ticketName] of ticketNames.entries()) {
    const match = /^(\d{2})-.+\.md$/.exec(ticketName);
    const expected = index + 1;
    if (!match || Number.parseInt(match[1], 10) !== expected) {
      throw new Error(`Sequential delivery tickets must be contiguous from 01; expected ${String(expected).padStart(2, '0')}-*.md but found ${ticketName}.`);
    }
  }
  return { specificationPath, issuesDirectory, ticketPaths: ticketNames.map(name => `${issuesDirectory}/${name}`) };
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
  return /^(\.scratch\/[^/]+)\/.+$/.exec(reference)?.[1];
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
    const exclusions = [':(exclude).scratch/**', ':(exclude)CONTEXT.md', ':(exclude)docs/architecture/adr/**'];
    const trackedPatch = runGit(workspaceCwd, ['diff', '--binary', 'HEAD', '--', '.', ...exclusions]);
    const trackedPaths = splitLines(runGit(workspaceCwd, ['diff', '--name-only', 'HEAD', '--', '.', ...exclusions]));
    const untrackedFiles = Object.fromEntries(runGit(workspaceCwd, ['ls-files', '--others', '--exclude-standard', '-z'])
      .split('\0').filter(Boolean).map(value => value.split(path.sep).join('/')).filter(file => !isDocumentationPath(file)).sort()
      .map(file => [file, fingerprintPath(path.join(workspaceCwd, file))]));
    return { trackedPatch, trackedPaths, untrackedFiles };
  } catch { return undefined; }
}

function validateWorkspaceState(before: WorkspaceState | undefined, after: WorkspaceState | undefined): string | undefined {
  if (!before || !after || (before.trackedPatch === after.trackedPatch && JSON.stringify(before.untrackedFiles) === JSON.stringify(after.untrackedFiles))) return undefined;
  const untracked = new Set([...Object.keys(before.untrackedFiles), ...Object.keys(after.untrackedFiles)]);
  const changed = [...untracked].filter(file => before.untrackedFiles[file] !== after.untrackedFiles[file]);
  const paths = [...new Set([...after.trackedPaths, ...changed])].sort();
  return `Documentation-only nodes changed workspace files outside .scratch, CONTEXT.md, or docs/architecture/adr/${paths.length ? `: ${paths.join(', ')}` : ''}`;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function splitLines(value: string): string[] { return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean); }
function isDocumentationPath(file: string): boolean {
  return file === 'CONTEXT.md' || file === '.scratch' || file.startsWith('.scratch/')
    || file === 'docs/architecture/adr' || file.startsWith('docs/architecture/adr/');
}
function fingerprintPath(file: string): string {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return createHash('sha256').update(`link:${fs.readlinkSync(file)}`).digest('hex');
  if (stat.isFile()) return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return createHash('sha256').update(`mode:${stat.mode}:size:${stat.size}`).digest('hex');
}
