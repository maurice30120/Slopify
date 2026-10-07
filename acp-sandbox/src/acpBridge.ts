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
import { IntegrationConflictError, type IntegrationConflict } from './gitPromotion.js';

/** Type métier DockerSandboxAcpBridgeOptions utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type DockerSandboxAcpBridgeOptions = Omit<
  SandboxRunInput,
  'workspaceCwd' | 'prompt' | 'signal'
>;

/** Contrat fonctionnel de SandboxBridgeFailure dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface SandboxBridgeFailure {
  code: string;
  message: string;
  diagnostic?: string;
  conflict?: IntegrationConflict;
}

/** Type métier SandboxBridgePreviewResponse utilisé pour représenter une étape ou un résultat du cycle de vie du pipeline. */
export type SandboxBridgePreviewResponse =
  | { ok: true; result: SandboxRunResult }
  | { ok: false; error: SandboxBridgeFailure };

/** Contrat fonctionnel de BridgeSession dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
interface BridgeSession {
  cwd: string;
  active?: AbortController;
  result?: SandboxRunResult;
  failure?: SandboxBridgeFailure;
}

/** Agent ACP qui possède un Sandbox Run Docker derrière la frontière de protocole. */
export class DockerSandboxAcpBridgeAgent implements Agent {
  private readonly sessions = new Map<string, BridgeSession>();

/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
  constructor(
    private readonly connection: AgentSideConnection,
    private readonly runtime: DockerSandboxRuntime,
    private readonly options: DockerSandboxAcpBridgeOptions,
  ) {}

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async initialize(_params: InitializeRequest) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'Docker Sandbox Codex', version: '0.1.0' },
      agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
    };
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async authenticate(_params: AuthenticateRequest) { return {}; }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async newSession(params: NewSessionRequest) {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { cwd: params.cwd });
    return { sessionId };
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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
      const responseText = this.options.agent === 'vibe'
        ? vibeResponseText(session.result.stdout)
        : session.result.stdout;
      if (responseText.trim()) {
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: responseText },
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

/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  async cancel(params: CancelNotification) {
    this.sessions.get(params.sessionId)?.active?.abort(new Error('Sandbox ACP prompt cancelled.'));
  }

/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  async closeSession(params: CloseSessionRequest) {
    this.sessions.get(params.sessionId)?.active?.abort(new Error('Sandbox ACP session closed.'));
    this.sessions.delete(params.sessionId);
    return {};
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private requireSession(sessionId: string): BridgeSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Sandbox ACP session not found: ${sessionId || '(missing)'}`);
    return session;
  }
}

/** Agent ACP minimal utilisé pour invoquer les extensions du cycle de vie lors de la finalisation. */
export class SandboxAcpExtensionAgent implements Agent {
  private readonly sessions = new Set<string>();

/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
  constructor(private readonly extensions: SandboxAcpExtensionHandler) {}

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async initialize(_params: InitializeRequest) {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
  }
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async authenticate(_params: AuthenticateRequest) { return {}; }
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async newSession(_params: NewSessionRequest) {
    const sessionId = randomUUID();
    this.sessions.add(sessionId);
    return { sessionId };
  }
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async prompt(params: PromptRequest) {
    this.requireSession(params.sessionId);
    return { stopReason: 'end_turn' as const };
  }
/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  async cancel(_params: CancelNotification) {}
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async extMethod(method: string, params: Record<string, unknown>) {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    this.requireSession(sessionId);
    const { sessionId: _sessionId, ...request } = params;
    return this.extensions.extMethod(method, request);
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private requireSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) throw new Error(`Sandbox ACP extension session not found: ${sessionId || '(missing)'}`);
  }
}

/** Point d'entrée textPrompt du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function textPrompt(params: PromptRequest): string {
  const parts = params.prompt.map(block => {
    if (block.type !== 'text') throw new Error(`Docker Sandbox Codex supports only ACP text prompts; received ${block.type}.`);
    return block.text;
  });
  const prompt = parts.join('\n\n').trim();
  if (!prompt) throw new Error('Docker Sandbox Codex requires a non-empty ACP prompt.');
  return prompt;
}

/** Le JSON de Vibe contient le prompt et les effets des outils ; ACP ne reçoit que la réponse finale. */
function vibeResponseText(stdout: string): string {
  let entries: unknown;
  try {
    entries = JSON.parse(stdout);
  } catch {
    throw new Error('Mistral Vibe returned invalid JSON output.');
  }
  if (!Array.isArray(entries)) throw new Error('Mistral Vibe output must be a message array.');
  const finalMessage = entries.slice().reverse().find(entry =>
    entry && entry.type === 'message' && entry.role === 'assistant',
  );
  const text = Array.isArray(finalMessage?.content)
    ? finalMessage.content.filter((block: unknown) =>
      block && typeof block === 'object' && 'type' in block && block.type === 'text'
      && 'text' in block && typeof block.text === 'string',
    ).map((block: { text: string }) => block.text).join('\n')
    : '';
  if (!text.trim()) throw new Error('Mistral Vibe output contains no final assistant text.');
  return text;
}

/** Point d'entrée bridgeFailure du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function bridgeFailure(error: unknown): SandboxBridgeFailure {
  if (error instanceof IntegrationConflictError) {
    return { code: error.code, message: error.message, conflict: error.conflict };
  }
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
