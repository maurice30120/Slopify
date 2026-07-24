import { AgentProcessManager, observeAgentProcessExit, type AgentProcessExit, type ProcessAgentConfig } from './agentProcess.js';
import { ConnectionManager, type ConnectionInfo } from './connectionManager.js';
import type { PartialAcpOperationTimeouts } from './operationGuards.js';
import { SessionUpdateHandler } from './sessionUpdateHandler.js';
import type { Logger, RuntimePermissionContext } from '../types.js';

export interface AcpConnectorInput {
  agentName: string;
  processConfig: ProcessAgentConfig;
  workspaceCwd: string;
  sessionUpdateHandler: SessionUpdateHandler;
  getPermissionContext: () => RuntimePermissionContext | undefined;
  autoApprovePermissions?: boolean;
  timeouts?: PartialAcpOperationTimeouts;
  logger?: Logger;
}

export interface ConnectedAcpAgent {
  agentId: string;
  connInfo: ConnectionInfo;
  processExit?: Promise<AgentProcessExit>;
  dispose: () => void;
}

export type AcpConnector = (input: AcpConnectorInput) => Promise<ConnectedAcpAgent>;

export const defaultAcpConnector: AcpConnector = async (input) => {
  const agentManager = new AgentProcessManager(input.logger);
  const connectionManager = new ConnectionManager(input.sessionUpdateHandler, {
    logger: input.logger,
    getPermissionContext: input.getPermissionContext,
    autoApprovePermissions: input.autoApprovePermissions === true,
    timeouts: input.timeouts,
  });

  const agentInstance = agentManager.spawnAgent(input.agentName, input.processConfig, input.workspaceCwd);
  const agentId = agentInstance.id;
  const processExit = observeAgentProcessExit(agentInstance);

  let connInfo: ConnectionInfo;
  try {
    connInfo = await connectionManager.connect(agentId, agentInstance.process, input.workspaceCwd, processExit);
  } catch (e: unknown) {
    agentManager.killAgent(agentId);
    connectionManager.dispose();
    throw e;
  }

  const dispose = (): void => {
    agentManager.killAll();
    connectionManager.dispose();
    input.sessionUpdateHandler.dispose();
  };

  return { agentId, connInfo, processExit, dispose };
};
