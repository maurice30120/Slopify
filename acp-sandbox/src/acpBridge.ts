import {
  PROTOCOL_VERSION,
  type Agent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type CloseSessionRequest,
  type InitializeRequest,
  type NewSessionRequest,
  type PromptRequest,
} from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';

import { SandboxAcpExtensionHandler } from './extensions.js';
import {
  DockerSandboxRuntime,
  SandboxResumeDivergenceError,
  type SandboxRunInput,
  type SandboxRunResult,
} from './runtime.js';

export type DockerSandboxAcpBridgeOptions = Omit<
  SandboxRunInput,
  'workspaceCwd' | 'prompt' | 'signal'
>;

export interface SandboxBridgeFailure {
  code: string;
  message: string;
  diagnostic?: string;
}

export type SandboxBridgePreviewResponse =
  | { ok: true; result: SandboxRunResult }
  | { ok: false; error: SandboxBridgeFailure };

interface BridgeSession {
  cwd: string;
  active?: AbortController;
  result?: SandboxRunResult;
  failure?: SandboxBridgeFailure;
}

/** ACP agent that owns one Docker Sandbox run behind the protocol boundary. */
export class DockerSandboxAcpBridgeAgent implements Agent {
  private readonly sessions = new Map<string, BridgeSession>();

  constructor(
    private readonly connection: AgentSideConnection,
    private readonly runtime: DockerSandboxRuntime,
    private readonly options: DockerSandboxAcpBridgeOptions,
  ) {}

  async initialize(_params: InitializeRequest) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'Docker Sandbox Codex', version: '0.1.0' },
      agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
    };
  }

  async authenticate(_params: AuthenticateRequest) { return {}; }

  async newSession(params: NewSessionRequest) {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { cwd: params.cwd });
    return { sessionId };
  }

  async prompt(params: PromptRequest) {
    const session = this.requireSession(params.sessionId);
    if (session.active) throw new Error(`Sandbox ACP session ${params.sessionId} is already running.`);
    const controller = new AbortController();
    session.active = controller;
    session.failure = undefined;
    try {
      session.result = await this.runtime.runCodex({
        ...this.options,
        workspaceCwd: session.cwd,
        prompt: textPrompt(params),
        signal: controller.signal,
      });
      if (session.result.stdout.trim()) {
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: session.result.stdout },
          },
        });
      }
      return { stopReason: 'end_turn' as const };
    } catch (error: unknown) {
      if (controller.signal.aborted) return { stopReason: 'cancelled' as const };
      session.failure = bridgeFailure(error);
      return { stopReason: 'end_turn' as const };
    } finally {
      session.active = undefined;
    }
  }

  async cancel(params: CancelNotification) {
    this.sessions.get(params.sessionId)?.active?.abort(new Error('Sandbox ACP prompt cancelled.'));
  }

  async closeSession(params: CloseSessionRequest) {
    this.sessions.get(params.sessionId)?.active?.abort(new Error('Sandbox ACP session closed.'));
    this.sessions.delete(params.sessionId);
    return {};
  }

  async extMethod(method: string, params: Record<string, unknown>) {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    const session = this.requireSession(sessionId);
    if (method === 'sandbox/status') {
      return {
        sessionId,
        running: Boolean(session.active),
        completed: Boolean(session.result),
        failed: Boolean(session.failure),
      };
    }
    if (method === 'sandbox/preview') {
      const response: SandboxBridgePreviewResponse = session.failure
        ? { ok: false, error: session.failure }
        : session.result
          ? { ok: true, result: session.result }
          : { ok: false, error: { code: 'sandbox_result_missing', message: 'Sandbox run produced no result.' } };
      return response as unknown as Record<string, unknown>;
    }
    throw new Error(`Sandbox ACP extension "${method}" is unavailable during an agent run.`);
  }

  private requireSession(sessionId: string): BridgeSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Sandbox ACP session not found: ${sessionId || '(missing)'}`);
    return session;
  }
}

/** Minimal ACP agent used to invoke lifecycle extensions during finalization. */
export class SandboxAcpExtensionAgent implements Agent {
  private readonly sessions = new Set<string>();

  constructor(private readonly extensions: SandboxAcpExtensionHandler) {}

  async initialize(_params: InitializeRequest) {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
  }
  async authenticate(_params: AuthenticateRequest) { return {}; }
  async newSession(_params: NewSessionRequest) {
    const sessionId = randomUUID();
    this.sessions.add(sessionId);
    return { sessionId };
  }
  async prompt(params: PromptRequest) {
    this.requireSession(params.sessionId);
    return { stopReason: 'end_turn' as const };
  }
  async cancel(_params: CancelNotification) {}
  async extMethod(method: string, params: Record<string, unknown>) {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    this.requireSession(sessionId);
    const { sessionId: _sessionId, ...request } = params;
    return this.extensions.extMethod(method, request);
  }

  private requireSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) throw new Error(`Sandbox ACP extension session not found: ${sessionId || '(missing)'}`);
  }
}

function textPrompt(params: PromptRequest): string {
  const parts = params.prompt.map(block => {
    if (block.type !== 'text') throw new Error(`Docker Sandbox Codex supports only ACP text prompts; received ${block.type}.`);
    return block.text;
  });
  const prompt = parts.join('\n\n').trim();
  if (!prompt) throw new Error('Docker Sandbox Codex requires a non-empty ACP prompt.');
  return prompt;
}

function bridgeFailure(error: unknown): SandboxBridgeFailure {
  if (error instanceof SandboxResumeDivergenceError) {
    return { code: error.code, message: error.message, diagnostic: error.diagnostic };
  }
  if (error instanceof Error) {
    const withCode = error as Error & { code?: unknown };
    const code = typeof withCode.code === 'string'
      ? withCode.code
      : 'sandbox_run_failed';
    return { code, message: error.message };
  }
  return { code: 'sandbox_run_failed', message: String(error) };
}
