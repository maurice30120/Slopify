import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  PipelineRuntime,
  PipelineRuntimeAgentAdapter,
  resolvePipelineStepText,
  workspacePipelineRunStore,
  type AgentNodeSessionFactory,
  type CompiledPipelineProgram,
  type CompiledPipelineNode,
  type PipelineAgentRunInput,
  type PipelineAgentRunner,
  type PipelineArtifact,
  type PipelineNodeArtifactSummary,
  type PipelineResumeDecision,
  type PipelineRuntimeResult,
  type PipelineRunStore,
} from '@acp-client/pipeline';
import { synthesizeTicketGraphArtifact } from '@acp-client/workspace';

import type { LogLevel } from './args.js';
import { MarkdownBlockStream } from './markdownBlockStream.js';
import type { CliTerminal } from './terminal.js';

type SessionNotification = Parameters<NonNullable<PipelineAgentRunInput['onSessionUpdate']>>[0];

export interface CliLogger {
  log(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface CliPipelineBackend {
  programs: CompiledPipelineProgram[];
  restoreProgram?(runId: string): CompiledPipelineProgram;
  preflightPipeline?(program: CompiledPipelineProgram, runId: string): Promise<void>;
  runAgent?: PipelineAgentRunner;
  clearRunLogs?(): void;
}

export interface CliPipelineBackendContext {
  terminal: Pick<CliTerminal, 'confirm' | 'select'>;
  logger: CliLogger;
}

export type CliPipelineBackendFactory = (
  workspaceCwd: string,
  context: CliPipelineBackendContext,
) => CliPipelineBackend;

export interface CliPipelineListEntry {
  id: string;
  title: string;
  nodeCount: number;
}

export interface CliPipelineHostOptions {
  terminal: CliTerminal;
  backendFactory: CliPipelineBackendFactory;
  logLevel?: LogLevel;
  createSession?: AgentNodeSessionFactory;
  runAgent?: PipelineAgentRunner;
  runIdFactory?: () => string;
}

/**
 * Adapte le runtime de pipeline au cycle de vie de la CLI. Les runs en pause
 * restent attachés à leur instance pour pouvoir reprendre leurs sessions ; les
 * runs terminaux sont retirés immédiatement pour ne pas conserver de processus.
 */
export class CliPipelineHost {
  private readonly backend: CliPipelineBackend;
  private readonly programs: CompiledPipelineProgram[];
  private readonly runtimes = new Map<string, PipelineRuntime>();
  private readonly createSession: AgentNodeSessionFactory;
  private readonly logger: CliLogger;
  private readonly runLogs = new Map<string, PipelineRunLog>();
  private readonly activeAgentNodes = new Map<string, CompiledPipelineNode>();
  private readonly activityByNode = new Map<string, 'agent_message_chunk' | 'agent_thought_chunk'>();
  private readonly streamedContentByNode = new Set<string>();
  /** Dernier contenu reçu, car certains adaptateurs renvoient le texte cumulatif. */
  private readonly streamedTextByNode = new Map<string, string>();
  private readonly blockStreamByNode = new Map<string, MarkdownBlockStream>();
  private readonly runStore: PipelineRunStore;
  private readonly logLevel: LogLevel;

  constructor(
    private readonly workspaceCwd: string,
    private readonly options: CliPipelineHostOptions,
  ) {
    this.runStore = workspacePipelineRunStore(workspaceCwd);
    this.logLevel = this.options.logLevel ?? 'default';
    this.logger = {
      log: message => {
        this.appendHostLog('host_log', { message });
        // Le diagnostic « Agent "…" exited (code=…, signal=SIGTERM) » arrive de
        // façon asynchrone quand le runtime libère le processus agent à la pause.
        // Écrit sur stderr, il se colle au prompt de lecture (`Answer …:`) qui
        // vient d'être affiché, et l'utilisateur croit que l'agent a planté
        // alors qu'il s'agit d'une libération normale. On le garde dans le run
        // log (diagnostic) sans l'afficher dans le terminal.
        if (this.shouldLog('verbose') && !AGENT_EXIT_LOG.test(message)) {
          this.options.terminal.writeError(`[slopify] ${message}`);
        }
      },
      error: (message, error) => {
        const suffix = error === undefined ? '' : `: ${formatError(error)}`;
        this.appendHostLog('host_error', {
          message,
          error: error === undefined ? undefined : serializeError(error),
        });
        if (this.shouldLog('default')) {
          this.options.terminal.writeError(`[slopify] ${message}${suffix}`);
        }
      },
    };

    this.backend = this.options.backendFactory(this.workspaceCwd, {
      terminal: this.options.terminal,
      logger: this.logger,
    });
    this.programs = this.backend.programs;

    if (this.options.createSession) {
      this.createSession = this.options.createSession;
      return;
    }

    const runner = this.options.runAgent ?? this.backend.runAgent;
    if (!runner) {
      throw new Error('The CLI backend must provide runAgent when createSession is not supplied.');
    }
    this.createSession = this.createDefaultSessionFactory(runner);
  }

  listPipelines(): CliPipelineListEntry[] {
    return this.programs.map(program => ({
      id: program.id,
      title: program.title,
      nodeCount: program.nodes.length,
    }));
  }

  async start(pipelineName: string, prompt: string): Promise<PipelineRuntimeResult> {
    const program = this.programs.find(candidate =>
      candidate.id === pipelineName || candidate.title === pipelineName,
    );
    if (!program) {
      throw new Error(`ACP pipeline "${pipelineName}" was not found in .acp/pipelines.`);
    }

    const runId = this.options.runIdFactory?.() ?? randomUUID();
    await this.backend.preflightPipeline?.(program, runId);
    PipelineRunLog.clear(this.workspaceCwd);
    this.backend.clearRunLogs?.();
    const runLog = PipelineRunLog.create(this.workspaceCwd, runId, program.id);
    this.runLogs.set(runId, runLog);
    runLog.append('run_started', {
      runId,
      pipelineId: program.id,
      pipelineTitle: program.title,
      promptBytes: Buffer.byteLength(prompt, 'utf8'),
    });
    const runtime = this.createRuntime(program, runId);
    this.runtimes.set(runId, runtime);
    const result = await runtime.start(program, { inputs: { userPrompt: prompt } });
    runLog.append('run_result', summarizeRuntimeResult(result));
    this.cleanupTerminalResult(result);
    return result;
  }

  async resume(runId: string, decision: PipelineResumeDecision): Promise<PipelineRuntimeResult> {
    const runtime = await this.requireRuntime(runId);
    const result = await runtime.resume(runId, decision);
    this.runLogs.get(runId)?.append('run_resumed_result', summarizeRuntimeResult(result));
    this.cleanupTerminalResult(result);
    return result;
  }

  async cancel(runId: string): Promise<PipelineRuntimeResult> {
    const runtime = await this.requireRuntime(runId);
    const result = await runtime.cancel(runId);
    this.runLogs.get(runId)?.append('run_cancelled_result', summarizeRuntimeResult(result));
    this.runtimes.delete(runId);
    this.runLogs.delete(runId);
    return result;
  }

  async dispose(): Promise<void> {
    const entries = [...this.runtimes.entries()];
    this.runtimes.clear();
    await Promise.all(entries.map(async ([runId, runtime]) => {
      try {
        await runtime.cancel(runId);
      } catch (error: unknown) {
        this.logger.error(`Failed to cancel pipeline run ${runId}`, error);
      }
    }));
  }

  private cleanupTerminalResult(result: PipelineRuntimeResult): void {
    if (result.status !== 'paused') {
      this.runtimes.delete(result.runId);
      this.runLogs.delete(result.runId);
      this.activeAgentNodes.clear();
      for (const key of this.activityByNode.keys()) {
        if (key.startsWith(`${result.runId}:`)) {
          this.activityByNode.delete(key);
        }
      }
      for (const key of this.streamedContentByNode) {
        if (key.startsWith(`${result.runId}:`)) {
          this.streamedContentByNode.delete(key);
        }
      }
      for (const key of this.streamedTextByNode.keys()) {
        if (key.startsWith(`${result.runId}:`)) {
          this.streamedTextByNode.delete(key);
        }
      }
      for (const key of this.blockStreamByNode.keys()) {
        if (key.startsWith(`${result.runId}:`)) {
          this.blockStreamByNode.delete(key);
        }
      }
    }
  }

  private shouldLog(minLevel: LogLevel): boolean {
    return LOG_LEVEL_RANK[this.logLevel] >= LOG_LEVEL_RANK[minLevel];
  }

  async recover(runId: string): Promise<PipelineRuntimeResult> {
    const runtime = await this.requireRuntime(runId);
    const result = await runtime.recover(runId);
    this.runLogs.get(runId)?.append('run_recovered_result', summarizeRuntimeResult(result));
    this.cleanupTerminalResult(result);
    return result;
  }

  private createRuntime(program: CompiledPipelineProgram, runId: string): PipelineRuntime {
    return new PipelineRuntime({ createSession: this.createSession }, {
      runIdFactory: () => runId,
      programs: [program],
      store: this.runStore,
      synthesizeArtifacts: (artifact: PipelineArtifact) => {
        const graph = synthesizeTicketGraphArtifact(this.workspaceCwd, artifact);
        return graph ? [graph] : [];
      },
      onEvent: event => {
        const log = this.runLogs.get(event.runId);
        const eventNode = event.nodeId ? program.nodesById.get(event.nodeId) : undefined;
        if (event.type === 'node_started' && eventNode?.agent) {
          this.activeAgentNodes.set(eventNode.agent, eventNode);
        }
        if (eventNode?.agent) log?.appendNode(eventNode, 'runtime_event', event);
        else log?.append('runtime_event', event);
        if ((event.type === 'node_completed' || event.type === 'node_failed') && eventNode?.agent) {
          this.activeAgentNodes.delete(eventNode.agent);
        }
        if (this.shouldLog('default')) {
          if (event.type === 'node_started' && eventNode?.agent) {
            this.options.terminal.writeError(`  ▶ ${formatAgentLabel(eventNode)}`);
          } else if (event.type === 'node_completed' && event.nodeId) {
            this.closeStreamedLine(event.runId, event.nodeId);
            const label = eventNode ? formatAgentLabel(eventNode) : event.nodeId;
            const parts = formatCompletionParts(event.durationMs, event.artifactSummary);
            this.options.terminal.writeError(`  ✓ ${label}${parts ? ' · ' + parts : ''}`);
          } else if (event.type === 'node_failed' && event.nodeId) {
            this.closeStreamedLine(event.runId, event.nodeId);
            const label = eventNode ? formatAgentLabel(eventNode) : event.nodeId;
            const dur = formatDuration(event.durationMs);
            const msg = event.message ? ` · ${event.message}` : '';
            this.options.terminal.writeError(`  ✗ ${label}${dur ? ' · ' + dur : ''}${msg}`);
          }
        }
        if (this.shouldLog('verbose')) {
          const node = event.nodeId ? ` node=${event.nodeId}` : '';
          const message = event.message ? ` ${event.message}` : '';
          this.options.terminal.writeError(`[runtime] ${event.type}${node}${message}`);
        }
        if ((event.type === 'node_completed' || event.type === 'node_failed') && event.nodeId) {
          this.activityByNode.delete(activityKey(event.runId, event.nodeId));
          this.streamedContentByNode.delete(activityKey(event.runId, event.nodeId));
          this.streamedTextByNode.delete(activityKey(event.runId, event.nodeId));
          this.blockStreamByNode.delete(activityKey(event.runId, event.nodeId));
        }
      },
    });
  }

  private async requireRuntime(runId: string): Promise<PipelineRuntime> {
    const active = this.runtimes.get(runId);
    if (active) return active;
    const snapshot = await this.runStore.load(runId);
    const program = snapshot
      ? this.backend.restoreProgram?.(runId) ?? this.programs.find(candidate => candidate.id === snapshot.pipelineId)
      : undefined;
    if (!snapshot || !program || (snapshot.status !== 'paused' && snapshot.status !== 'running')) {
      throw new Error(`Unknown active ACP pipeline run "${runId}".`);
    }
    const restored = this.createRuntime(program, runId);
    this.runtimes.set(runId, restored);
    return restored;
  }

  private findRunLog(_input: unknown): PipelineRunLog | undefined {
    if (this.runLogs.size !== 1) {
      return undefined;
    }
    return this.runLogs.values().next().value;
  }

  private appendHostLog(event: string, data: unknown): void {
    for (const log of this.runLogs.values()) {
      log.append(event, data);
      for (const node of this.activeAgentNodes.values()) {
        log.appendNode(node, event, data);
      }
    }
  }

  private createDefaultSessionFactory(runner: PipelineAgentRunner): AgentNodeSessionFactory {
    const loggedRunner = (async input => {
      const runLog = this.findRunLog(input);
      const activeNode = this.activeAgentNodes.get(input.agentName);
      const skills = this.shouldLog('verbose')
        ? ` (skills=${input.skills?.join(',') || 'none'})`
        : '';
      if (this.shouldLog('verbose')) {
        this.options.terminal.writeError(`[slopify] Starting node agent "${input.agentName}"${skills}`);
      }
      runLog?.appendForNode(activeNode, 'agent_started', {
        agentName: input.agentName,
        workspaceCwd: input.workspaceCwd,
        sideEffects: input.sideEffects,
        permissions: input.permissions,
        promotion: input.promotion,
        skills: input.skills ?? [],
        promptBytes: Buffer.byteLength(input.promptText, 'utf8'),
      });
      try {
        const result = await runner(input);
        runLog?.appendForNode(activeNode, 'agent_completed', {
          agentName: input.agentName,
          textBytes: Buffer.byteLength(resolvePipelineStepText(result), 'utf8'),
          promotion: typeof result === 'object' ? result.promotion : undefined,
        });
        if (this.shouldLog('verbose')) {
          this.options.terminal.writeError(`[slopify] Agent "${input.agentName}" completed.`);
        }
        return result;
      } catch (error: unknown) {
        runLog?.appendForNode(activeNode, 'agent_failed', {
          agentName: input.agentName,
          error: serializeError(error),
        });
        this.logger.error(`Agent "${input.agentName}" failed`, error);
        throw error;
      }
    }) as PipelineAgentRunner;
    loggedRunner.finalizePipelineChangeSet = runner.finalizePipelineChangeSet
      ? input => runner.finalizePipelineChangeSet!(input)
      : undefined;

    return new PipelineRuntimeAgentAdapter({
      workspaceCwd: () => this.workspaceCwd,
      runAgent: loggedRunner,
      onSessionUpdate: (activeRunId, node, update) => {
        this.runLogs.get(activeRunId)?.appendNode(node, 'session_update', sanitizeSessionNotification(update));
        this.reportSessionUpdate(activeRunId, node, update);
      },
      onStatus: (activeRunId, node, update) => {
        this.runLogs.get(activeRunId)?.appendNode(node, 'status', update);
        if (this.shouldLog('debug')) {
          this.options.terminal.writeError(
            `[${node.id}:${node.agent ?? 'pause'}] ${update.status}: ${update.message}`,
          );
        }
      },
    }).asSessionFactory();
  }

  private reportSessionUpdate(runId: string, node: CompiledPipelineNode, notification: SessionNotification): void {
    const update = notification.update;
    const kind = update?.sessionUpdate;
    if (kind !== 'agent_thought_chunk' && kind !== 'agent_message_chunk') {
      return;
    }

    const key = activityKey(runId, node.id);
    const previous = this.activityByNode.get(key);
    if (previous !== kind) {
      this.activityByNode.set(key, kind);
      if (this.shouldLog('verbose')) {
        // Vide le tampon de la phase précédente (rendu par blocs) avant
        // d'écrire l'en-tête de la nouvelle phase (réfléchit → répond). En
        // texte brut, un saut de ligne suffit car les écritures n'en ajoutent
        // pas ; en mode blocs, le rendu se termine déjà par un saut de ligne.
        if (this.streamedContentByNode.has(key)) {
          const stream = this.blockStreamByNode.get(key);
          if (stream) {
            const remaining = stream.flush();
            if (remaining) this.options.terminal.writeErrorRaw(remaining);
            this.blockStreamByNode.delete(key);
          } else {
            this.options.terminal.writeErrorRaw('\n');
          }
        }
        this.streamedTextByNode.delete(key);
        const label = formatAgentLabel(node);
        const action = kind === 'agent_thought_chunk' ? 'réfléchit' : 'répond';
        this.options.terminal.writeError(`[slopify] ${label} ${action}`);
      }
    }

    // Streaming en direct du contenu des pensées et de la réponse. Le contenu
    // des pensées reste exclu de la persistance (.acp/logs) — voir
    // sanitizeSessionNotification — mais s'affiche ici à la demande.
    // Sur un TTY, le Markdown est rendu par blocs terminés via markstream-cli
    // (chaque bloc écrit une seule fois, sans déplacement de curseur) ; sur un
    // flux non-TTY (pipe, tests) ou avec SLOPIFY_ANSI_STREAM=0, le texte brut
    // est écrit tel quel.
    if (this.shouldLog('verbose')) {
      const content = update?.content;
      const incomingText = content?.type === 'text' ? content.text : '';
      const previousText = this.streamedTextByNode.get(key) ?? '';
      // ACP implementations differ: some send deltas, others resend the full
      // accumulated message. In the latter case only render the new suffix.
      const text = incomingText.startsWith(previousText)
        ? incomingText.slice(previousText.length)
        : incomingText;
      this.streamedTextByNode.set(key, incomingText);
      if (text) {
        // Sur TTY le rendu par blocs est le comportement par défaut. Les flux
        // non-TTY ou SLOPIFY_ANSI_STREAM=0 conservent le texte brut.
        const renderBlocks = this.options.terminal.supportsAnsi
          && process.env.SLOPIFY_ANSI_STREAM !== '0';
        if (renderBlocks) {
          let stream = this.blockStreamByNode.get(key);
          if (!stream) {
            stream = new MarkdownBlockStream({ width: this.options.terminal.columns });
            this.blockStreamByNode.set(key, stream);
          }
          const rendered = stream.push(text);
          if (rendered) {
            this.options.terminal.writeErrorRaw(rendered);
          }
        } else {
          this.options.terminal.writeErrorRaw(text);
        }
        this.streamedContentByNode.add(key);
      }
    }
  }

  private closeStreamedLine(runId: string, nodeId: string): void {
    const key = activityKey(runId, nodeId);
    if (this.streamedContentByNode.delete(key)) {
      const stream = this.blockStreamByNode.get(key);
      if (stream) {
        const remaining = stream.flush();
        if (remaining) this.options.terminal.writeErrorRaw(remaining);
        this.blockStreamByNode.delete(key);
      } else {
        this.options.terminal.writeErrorRaw('\n');
      }
      this.streamedTextByNode.delete(key);
    }
  }
}

class PipelineRunLog {
  private readonly nodeLogFiles = new Map<string, string>();

  private constructor(
    private readonly logsDir: string,
    private readonly filePrefix: string,
    private readonly filePath: string,
    private readonly runId: string,
    private readonly pipelineId: string,
  ) {}

  static create(workspaceCwd: string, runId: string, pipelineId: string): PipelineRunLog {
    const logsDir = path.join(workspaceCwd, '.acp', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const safePipelineId = pipelineId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePrefix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${safePipelineId}-${safeRunId}`;
    const filePath = path.join(logsDir, `${filePrefix}.jsonl`);
    return new PipelineRunLog(logsDir, filePrefix, filePath, runId, pipelineId);
  }

  static clear(workspaceCwd: string): void {
    const logsDir = path.join(workspaceCwd, '.acp', 'logs');
    fs.rmSync(logsDir, { recursive: true, force: true });
    fs.mkdirSync(logsDir, { recursive: true });
  }

  append(event: string, data: unknown): void {
    fs.appendFileSync(this.filePath, `${JSON.stringify({
      ts: new Date().toISOString(),
      runId: this.runId,
      pipelineId: this.pipelineId,
      event,
      data,
    })}\n`);
  }

  appendNode(node: CompiledPipelineNode, event: string, data: unknown): void {
    const payload = {
      nodeId: node.id,
      agent: node.agent,
      data,
    };
    this.append(event, payload);
    fs.appendFileSync(this.nodeLogFile(node), `${JSON.stringify({
      ts: new Date().toISOString(),
      runId: this.runId,
      pipelineId: this.pipelineId,
      event,
      data: payload,
    })}\n`);
  }

  appendForNode(node: CompiledPipelineNode | undefined, event: string, data: unknown): void {
    if (node) {
      this.appendNode(node, event, data);
      return;
    }
    this.append(event, data);
  }

  private nodeLogFile(node: CompiledPipelineNode): string {
    const key = node.id;
    const existing = this.nodeLogFiles.get(key);
    if (existing) {
      return existing;
    }
    const safeNodeId = node.id.replace(/[^a-zA-Z0-9._-]/g, '_');
    const safeAgent = (node.agent ?? 'agent').replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(this.logsDir, `${this.filePrefix}-${safeNodeId}-${safeAgent}.jsonl`);
    this.nodeLogFiles.set(key, filePath);
    return filePath;
  }
}

function sanitizeSessionNotification(notification: SessionNotification): unknown {
  const update = notification.update;
  const kind = update?.sessionUpdate;
  if (kind === 'agent_message_chunk') {
    return update;
  }
  if (kind === 'agent_thought_chunk') {
    // Les logs conservent l'existence et la taille d'une pensée pour le diagnostic,
    // jamais son contenu. Le texte de raisonnement ne doit pas être persisté dans
    // `.acp/logs`, même en mode verbose.
    const content = update.content;
    const text = content.type === 'text' ? content.text : '';
    return {
      sessionUpdate: kind,
      content: {
        type: content.type,
        textBytes: Buffer.byteLength(text, 'utf8'),
      },
    };
  }
  return update;
}

function summarizeRuntimeResult(result: PipelineRuntimeResult): unknown {
  if (result.status === 'failed') {
    return {
      status: result.status,
      runId: result.runId,
      error: result.error,
    };
  }
  if (result.status === 'paused') {
    return {
      status: result.status,
      runId: result.runId,
      pause: {
        id: result.pause.id,
        nodeId: result.pause.nodeId,
        type: result.pause.type,
        format: result.pause.format,
        contentBytes: Buffer.byteLength(result.pause.content, 'utf8'),
      },
    };
  }
  return {
    status: result.status,
    runId: result.runId,
    artifact: result.status === 'completed' && result.artifact
      ? {
          name: result.artifact.name,
          type: result.artifact.type,
          format: result.artifact.format,
          producerNodeId: result.artifact.producerNodeId,
          valueBytes: Buffer.byteLength(String(result.artifact.value ?? ''), 'utf8'),
        }
      : undefined,
  };
}

function serializeError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }
  const extras = error as Error & { code?: unknown; data?: unknown };
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: extras.code,
    data: extras.data,
  };
}

function activityKey(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`;
}

function formatAgentLabel(node: CompiledPipelineNode): string {
  return node.agent && node.agent !== node.id
    ? `${node.id} · ${node.agent}`
    : node.id;
}

const LOG_LEVEL_RANK: Record<LogLevel, number> = { quiet: 0, default: 1, verbose: 2, debug: 3 };

// Diagnostic de fin de processus agent émis par acp-runtime (agentProcess.ts).
// Voir host logger.log pour la raison de ne pas l'afficher dans le terminal.
const AGENT_EXIT_LOG = /^Agent ".*" exited \(code=.*\)$/u;

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatCompletionParts(
  durationMs: number | undefined,
  summary: PipelineNodeArtifactSummary | undefined,
): string {
  const parts: string[] = [];
  const dur = formatDuration(durationMs);
  if (dur) parts.push(dur);
  if (summary) {
    const summaryParts: string[] = [];
    if (summary.ticketCount !== undefined) summaryParts.push(`${summary.ticketCount} tickets`);
    if (summary.filesChanged !== undefined) summaryParts.push(`${summary.filesChanged} files`);
    if (summaryParts.length > 0) {
      parts.push(summaryParts.join(' · '));
    } else {
      parts.push(formatBytes(summary.valueBytes));
    }
  }
  return parts.join(' · ');
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const details: string[] = [error.message || error.name];
  const rpcError = error as Error & { code?: unknown; data?: unknown; cause?: unknown };
  if (rpcError.code !== undefined) {
    details.push(`code=${formatErrorValue(rpcError.code)}`);
  }
  if (rpcError.data !== undefined) {
    details.push(`data=${formatErrorValue(rpcError.data)}`);
  }
  if (rpcError.cause !== undefined) {
    details.push(`cause=${formatError(rpcError.cause)}`);
  }
  return details.join('; ');
}

function formatErrorValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
