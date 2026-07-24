import type { ContentBlock, PromptResponse, SessionNotification } from '@agentclientprotocol/sdk';

import { SessionAuthHandler } from './authHandler.js';
import type { ProcessAgentConfig } from './agentProcess.js';
import { defaultAcpConnector, type AcpConnector, type ConnectedAcpAgent } from './defaultConnector.js';
import {
  resolveTimeouts,
  withProcessGuard,
  withTimeout,
  type PartialAcpOperationTimeouts,
} from './operationGuards.js';
import { RunAbortedError } from './runAbortedError.js';
import { SessionUpdateHandler } from './sessionUpdateHandler.js';
import type { Logger, RuntimePermissionContext } from '../types.js';

export interface AcpRunRequest<TFinal = undefined> {
  agentName: string;
  sessionCwd: string;
  processConfig: ProcessAgentConfig;
  prompt: ContentBlock[];
  connector?: AcpConnector;
  getPermissionContext?: () => RuntimePermissionContext | undefined;
  autoApprovePermissions?: boolean;
  timeouts?: PartialAcpOperationTimeouts;
  signal?: AbortSignal;
  onSessionUpdate?: (update: SessionNotification) => void;
  finalize?: (context: AcpRunFinalizationContext) => Promise<TFinal>;
  logger?: Logger;
}

export interface AcpRunFinalizationContext {
  connected: ConnectedAcpAgent;
  sessionId: string;
}

export interface AcpRunResult<TFinal = undefined> {
  text: string;
  finalization: TFinal;
}

/** Executes one already-resolved ACP request without discovering workspace state. */
export class AcpRunner {
  async run<TFinal = undefined>(request: AcpRunRequest<TFinal>): Promise<AcpRunResult<TFinal>> {
    const sessionUpdateHandler = new SessionUpdateHandler();
    let connected: ConnectedAcpAgent | null = null;
    let sessionId: string | null = null;
    let collectedText = '';
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      connected?.dispose();
    };
    const throwIfAborted = () => {
      if (request.signal?.aborted) throw new RunAbortedError();
    };
    const onAbort = () => {
      void (async () => {
        if (sessionId && connected) {
          try { await connected.connInfo.connection.cancel({ sessionId }); }
          catch (error: unknown) { request.logger?.error('ACP cancel failed', error); }
        }
        dispose();
      })();
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const listener = (update: SessionNotification) => {
      if (sessionId && update.sessionId !== sessionId) return;
      if (update.update.sessionUpdate === 'agent_message_chunk' && update.update.content.type === 'text') {
        collectedText += update.update.content.text;
      }
      request.onSessionUpdate?.(update);
    };
    sessionUpdateHandler.addListener(listener);

    try {
      throwIfAborted();
      connected = await (request.connector ?? defaultAcpConnector)({
        agentName: request.agentName,
        processConfig: request.processConfig,
        workspaceCwd: request.sessionCwd,
        sessionUpdateHandler,
        getPermissionContext: request.getPermissionContext ?? (() => undefined),
        autoApprovePermissions: request.autoApprovePermissions,
        timeouts: request.timeouts,
        logger: request.logger,
      });
      throwIfAborted();
      const session = await this.createSessionWithAuth(request, connected, throwIfAborted);
      sessionId = session.sessionId;
      const response = await withProcessGuard(
        'prompt',
        connected.processExit,
        withTimeout(
          'prompt',
          resolveTimeouts(request.timeouts).promptMs,
          connected.connInfo.connection.prompt({ sessionId, prompt: request.prompt }),
          async () => {
            try { await connected?.connInfo.connection.cancel({ sessionId: sessionId ?? '' }); }
            catch (error: unknown) { request.logger?.error('ACP timeout cancel failed', error); }
            dispose();
          },
        ),
      );
      this.throwIfCancelled(response, request.signal);
      const finalization = request.finalize
        ? await request.finalize({ connected, sessionId })
        : undefined as TFinal;
      return { text: collectedText.trim(), finalization };
    } finally {
      request.signal?.removeEventListener('abort', onAbort);
      sessionUpdateHandler.removeListener(listener);
      dispose();
    }
  }

  private async createSessionWithAuth<T>(
    request: AcpRunRequest<T>,
    connected: ConnectedAcpAgent,
    throwIfAborted: () => void,
  ): Promise<{ sessionId: string }> {
    try {
      return await this.newSession(connected, request.sessionCwd, request.timeouts);
    } catch (error: unknown) {
      const auth = new SessionAuthHandler(
        () => connected.dispose(),
        request.getPermissionContext ?? (() => undefined),
        { timeouts: request.timeouts, processExit: connected.processExit },
      );
      if (!auth.isAuthRequiredError(error)) throw error;
      await auth.runAuthFlow(request.agentName, connected.agentId, connected.connInfo);
      throwIfAborted();
      return this.newSession(connected, request.sessionCwd, request.timeouts);
    }
  }

  private newSession(
    connected: ConnectedAcpAgent,
    cwd: string,
    timeouts?: PartialAcpOperationTimeouts,
  ): Promise<{ sessionId: string }> {
    return withProcessGuard(
      'newSession',
      connected.processExit,
      withTimeout(
        'newSession',
        resolveTimeouts(timeouts).newSessionMs,
        connected.connInfo.connection.newSession({ cwd, mcpServers: [] }),
        () => connected.dispose(),
      ),
    );
  }

  private throwIfCancelled(response: PromptResponse, signal?: AbortSignal): void {
    if (signal?.aborted || response.stopReason === 'cancelled') throw new RunAbortedError();
  }
}
