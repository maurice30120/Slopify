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

export class SessionAuthHandler {
  constructor(
    private readonly killAgent: (agentId: string) => void,
    private readonly getPermissionContext: () => RuntimePermissionContext | undefined,
    private readonly options: {
      timeouts?: PartialAcpOperationTimeouts;
      processExit?: Promise<AgentProcessExit>;
    } = {},
  ) {}

  isAuthRequiredError(error: unknown): boolean {
    return (error instanceof RequestError && error.code === -32000)
      || (isRecord(error) && error.code === -32000)
      || (isRecord(error) && typeof error.message === 'string' && /auth.?required/i.test(error.message));
  }

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
      withTimeout(
        'authenticate',
        resolveTimeouts(this.options.timeouts).authenticateMs,
        connInfo.connection.authenticate({ methodId: selectedMethod.id }),
        () => this.killAgent(agentId),
      ),
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
