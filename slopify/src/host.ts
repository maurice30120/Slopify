import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  PipelineRuntime,
  PipelineRuntimeAgentAdapter,
  resolvePipelineStepText,
  type AgentNodeSessionFactory,
  type CompiledPipelineProgram,
  type CompiledPipelineNode,
  type PipelineAgentRunInput,
  type PipelineAgentRunner,
  type PipelineResumeDecision,
  type PipelineRuntimeResult,
} from '@acp-client/pipeline';

import type { CliTerminal } from './terminal.js';

type SessionNotification = Parameters<NonNullable<PipelineAgentRunInput['onSessionUpdate']>>[0];

export interface CliLogger {
  log(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface CliPipelineBackend {
  programs: CompiledPipelineProgram[];
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
  verbose?: boolean;
  createSession?: AgentNodeSessionFactory;
  runAgent?: PipelineAgentRunner;
  runIdFactory?: () => string;
}

export class CliPipelineHost {
  private readonly backend: CliPipelineBackend;
  private readonly programs: CompiledPipelineProgram[];
  private readonly runtimes = new Map<string, PipelineRuntime>();
  private readonly createSession: AgentNodeSessionFactory;
  private readonly logger: CliLogger;
  private readonly runLogs = new Map<string, PipelineRunLog>();
  private readonly activeAgentNodes = new Map<string, CompiledPipelineNode>();
  private readonly activityByNode = new Map<string, 'agent_message_chunk' | 'agent_thought_chunk'>();

  constructor(
    private readonly workspaceCwd: string,
    private readonly options: CliPipelineHostOptions,
  ) {
    this.logger = {
      log: message => {
        this.appendHostLog('host_log', { message });
        if (this.options.verbose) {
          this.options.terminal.writeError(`[slopify] ${message}`);
        }
      },
      error: (message, error) => {
        const suffix = error === undefined ? '' : `: ${formatError(error)}`;
        this.appendHostLog('host_error', {
          message,
          error: error === undefined ? undefined : serializeError(error),
        });
        this.options.terminal.writeError(`[slopify] ${message}${suffix}`);
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
    const runtime = new PipelineRuntime({ createSession: this.createSession }, {
      runIdFactory: () => runId,
      programs: [program],
      onEvent: event => {
        const log = this.runLogs.get(event.runId);
        const eventNode = event.nodeId ? program.nodesById.get(event.nodeId) : undefined;
        if (event.type === 'node_started' && eventNode?.agent) {
          this.activeAgentNodes.set(eventNode.agent, eventNode);
        }
        if (eventNode?.agent) {
          log?.appendNode(eventNode, 'runtime_event', event);
        } else {
          log?.append('runtime_event', event);
        }
        if ((event.type === 'node_completed' || event.type === 'node_failed') && eventNode?.agent) {
          this.activeAgentNodes.delete(eventNode.agent);
        }
        if (this.options.verbose) {
          const node = event.nodeId ? ` node=${event.nodeId}` : '';
          const message = event.message ? ` ${event.message}` : '';
          this.options.terminal.writeError(`[runtime] ${event.type}${node}${message}`);
        }
        if ((event.type === 'node_completed' || event.type === 'node_failed') && event.nodeId) {
          this.activityByNode.delete(activityKey(event.runId, event.nodeId));
        }
      },
    });
    this.runtimes.set(runId, runtime);
    const result = await runtime.start(program, { inputs: { userPrompt: prompt } });
    runLog.append('run_result', summarizeRuntimeResult(result));
    this.cleanupTerminalResult(result);
    return result;
  }

  async resume(runId: string, decision: PipelineResumeDecision): Promise<PipelineRuntimeResult> {
    const runtime = this.runtimes.get(runId);
    if (!runtime) {
      throw new Error(`Unknown active ACP pipeline run "${runId}".`);
    }
    const result = await runtime.resume(runId, decision);
    this.runLogs.get(runId)?.append('run_resumed_result', summarizeRuntimeResult(result));
    this.cleanupTerminalResult(result);
    return result;
  }

  async cancel(runId: string): Promise<PipelineRuntimeResult> {
    const runtime = this.runtimes.get(runId);
    if (!runtime) {
      throw new Error(`Unknown active ACP pipeline run "${runId}".`);
    }
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
    }
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
    return new PipelineRuntimeAgentAdapter({
      workspaceCwd: () => this.workspaceCwd,
      runAgent: async input => {
        const runLog = this.findRunLog(input);
        const activeNode = this.activeAgentNodes.get(input.agentName);
        const skills = this.options.verbose
          ? ` (skills=${input.skills?.join(',') || 'none'})`
          : '';
        this.options.terminal.writeError(`[slopify] Starting node agent "${input.agentName}"${skills}`);
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
          if (this.options.verbose) {
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
      },
      onSessionUpdate: (activeRunId, node, update) => {
        this.runLogs.get(activeRunId)?.appendNode(node, 'session_update', sanitizeSessionNotification(update));
        this.reportSessionUpdate(activeRunId, node, update);
      },
      onStatus: (activeRunId, node, update) => {
        this.runLogs.get(activeRunId)?.appendNode(node, 'status', update);
        if (this.options.verbose) {
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
    if (this.activityByNode.get(key) === kind) {
      return;
    }
    this.activityByNode.set(key, kind);

    const label = formatAgentLabel(node);
    const action = kind === 'agent_thought_chunk' ? 'réfléchit' : 'répond';
    this.options.terminal.writeError(`[slopify] ${label} ${action}`);
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
