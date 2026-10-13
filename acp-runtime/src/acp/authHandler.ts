import { RequestError } from '@agentclientprotocol/sdk';

import type { ConnectionInfo } from './connectionManager.js';
import {
  resolveTimeouts,
  withProcessGuard,
  withTimeout,
  type PartialAcpOperationTimeouts,
} from './operationGuards.js';
import type { RuntimePermissionContext } from '../types.js';
import type { AgentProcessExit } from './agentProcess.js';

/** Composant SessionAuthHandler qui coordonne une étape observable du cycle de vie du pipeline et en préserve les invariants. */
export class SessionAuthHandler {
/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
  constructor(
    private readonly killAgent: (agentId: string) => void,
    private readonly getPermissionContext: () => RuntimePermissionContext | undefined,
    private readonly options: {
      timeouts?: PartialAcpOperationTimeouts;
      processExit?: Promise<AgentProcessExit>;
    } = {},
  ) {}

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  isAuthRequiredError(error: unknown): boolean {
    return (error instanceof RequestError && error.code === -32000)
      || (isRecord(error) && error.code === -32000)
      || (isRecord(error) && typeof error.message === 'string' && /auth.?required/i.test(error.message));
  }

/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async runAuthFlow(
    agentName: string,
    agentId: string,
    connInfo: ConnectionInfo,
  ): Promise<void> {
    const authMethods = connInfo.initResponse.authMethods;
    if (!authMethods || authMethods.length === 0) {
      this.killAgent(agentId);
      throw new Error(`Agent "${agentName}" requires authentication but did not advertise any auth methods.`);
    }

    const ctx = this.getPermissionContext();
    if (!ctx?.hasUI) {
      this.killAgent(agentId);
      throw new Error(`Agent "${agentName}" requires authentication, but runtime UI is not available.`);
    }

    let selectedMethod = authMethods[0];
    if (authMethods.length > 1) {
      const labels = authMethods.map(method => `${method.name} [${method.id}]`);
      const selected = await withTimeout(
        'auth-ui',
/** Valide ou résout les données de cette étape du cycle de vie ; les entrées invalides restent signalées au point d'appel. */
        resolveTimeouts(this.options.timeouts).authUiMs,
        ctx.ui.select(`${agentName} authentication`, labels),
        () => this.killAgent(agentId),
      );
      if (!selected) {
        this.killAgent(agentId);
        throw new Error('Authentication cancelled by user.');
      }
      const index = labels.indexOf(selected);
      selectedMethod = authMethods[index] ?? authMethods[0];
    } else {
      const ok = await withTimeout(
        'auth-ui',
/** Valide ou résout les données de cette étape du cycle de vie ; les entrées invalides restent signalées au point d'appel. */
        resolveTimeouts(this.options.timeouts).authUiMs,
        ctx.ui.confirm(
          `${agentName} authentication`,
          `Authenticate with "${selectedMethod.name}"?${selectedMethod.description ? `\n${selectedMethod.description}` : ''}`,
        ),
        () => this.killAgent(agentId),
      );
      if (!ok) {
        this.killAgent(agentId);
        throw new Error('Authentication cancelled by user.');
      }
    }

    await withProcessGuard(
      'authenticate',
      this.options.processExit,
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
      withTimeout(
        'authenticate',
/** Valide ou résout les données de cette étape du cycle de vie ; les entrées invalides restent signalées au point d'appel. */
        resolveTimeouts(this.options.timeouts).authenticateMs,
        connInfo.connection.authenticate({ methodId: selectedMethod.id }),
        () => this.killAgent(agentId),
      ),
    );
  }
}

/** Point d'entrée isRecord du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
