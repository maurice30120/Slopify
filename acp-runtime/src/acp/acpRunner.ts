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

/** Contrat fonctionnel de AcpRunRequest dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
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

/** Contrat fonctionnel de AcpRunFinalizationContext dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface AcpRunFinalizationContext {
  connected: ConnectedAcpAgent;
  sessionId: string;
}

/** Contrat fonctionnel de AcpRunResult dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface AcpRunResult<TFinal = undefined> {
  text: string;
  finalization: TFinal;
}

/**
 * Exécute une requête ACP déjà résolue, sans redécouvrir la configuration du
 * workspace. L'authentification peut recréer une session une seule fois, puis
 * tous les chemins terminaux convergent vers la même libération de connexion.
 */
export class AcpRunner {
/**
 * Exécute un tour ACP entre l'hôte et un agent, puis libère toujours session et processus.
 * Les chunks de réponse alimentent le texte final ; pensées et diagnostics restent des notifications.
 * @param request Requête résolue avec prompt, sandbox de session, permissions et délais.
 * @returns Le texte final et le résultat de finalisation éventuel.
 * @throws RunAbortedError en cas de Cancellation ; propage les erreurs ACP, d'authentification ou de délai.
 */
  async run<TFinal = undefined>(request: AcpRunRequest<TFinal>): Promise<AcpRunResult<TFinal>> {
    const sessionUpdateHandler = new SessionUpdateHandler();
    let connected: ConnectedAcpAgent | null = null;
    let sessionId: string | null = null;
    let collectedText = '';
    let disposed = false;
    // L'annulation asynchrone et le finally peuvent se croiser. Cette garde
    // garantit que les processus et connexions sous-jacents ne sont libérés
    // qu'une seule fois.
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      connected?.dispose();
    };
    const throwIfAborted = () => {
      if (request.signal?.aborted) throw new RunAbortedError();
    };
    const onAbort = () => {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
      void (async () => {
        if (sessionId && connected) {
          try { await connected.connInfo.connection.cancel({ sessionId }); }
          catch (error: unknown) { request.logger?.error('ACP cancel failed', error); }
        }
/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
        dispose();
      })();
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const listener = (update: SessionNotification) => {
      if (sessionId && update.sessionId !== sessionId) return;
      // Seuls les chunks de réponse constituent le résultat textuel. Les pensées
      // et notifications de diagnostic restent observables via onSessionUpdate,
      // mais ne doivent pas contaminer la sortie du nœud.
      if (update.update.sessionUpdate === 'agent_message_chunk' && update.update.content.type === 'text') {
        collectedText += update.update.content.text;
      }
      request.onSessionUpdate?.(update);
    };
    sessionUpdateHandler.addListener(listener);

    try {
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
      throwIfAborted();
      const session = await this.createSessionWithAuth(request, connected, throwIfAborted);
      sessionId = session.sessionId;
      const response = await withProcessGuard(
        'prompt',
        connected.processExit,
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
        withTimeout(
          'prompt',
/** Valide ou résout les données de cette étape du cycle de vie ; les entrées invalides restent signalées au point d'appel. */
          resolveTimeouts(request.timeouts).promptMs,
          connected.connInfo.connection.prompt({ sessionId, prompt: request.prompt }),
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
          async () => {
            try { await connected?.connInfo.connection.cancel({ sessionId: sessionId ?? '' }); }
            catch (error: unknown) { request.logger?.error('ACP timeout cancel failed', error); }
/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
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
/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
      dispose();
    }
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
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
      // Une erreur d'authentification autorise exactement un flux interactif et
      // une nouvelle tentative. Boucler ici masquerait une configuration invalide
      // et pourrait demander indéfiniment les mêmes credentials.
      await auth.runAuthFlow(request.agentName, connected.agentId, connected.connInfo);
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
      throwIfAborted();
      return this.newSession(connected, request.sessionCwd, request.timeouts);
    }
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private newSession(
    connected: ConnectedAcpAgent,
    cwd: string,
    timeouts?: PartialAcpOperationTimeouts,
  ): Promise<{ sessionId: string }> {
    return withProcessGuard(
      'newSession',
      connected.processExit,
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
      withTimeout(
        'newSession',
/** Valide ou résout les données de cette étape du cycle de vie ; les entrées invalides restent signalées au point d'appel. */
        resolveTimeouts(timeouts).newSessionMs,
        connected.connInfo.connection.newSession({ cwd, mcpServers: [] }),
        () => connected.dispose(),
      ),
    );
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  private throwIfCancelled(response: PromptResponse, signal?: AbortSignal): void {
    if (signal?.aborted || response.stopReason === 'cancelled') throw new RunAbortedError();
  }
}
