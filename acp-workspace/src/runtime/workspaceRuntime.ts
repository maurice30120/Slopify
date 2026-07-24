import {
  renderAcpPrompt,
  type CompiledPipelineProgram,
  type PipelineAgentRunInput,
  type PipelineAgentRunner,
  type PipelinePromotionStatus,
} from '@acp-client/pipeline';
import {
  AcpRunner,
  PipelineTimeoutError,
  resolveTimeouts,
  withTimeout,
  type AcpConnector,
  type AcpRunFinalizationContext,
} from '@acp-client/runtime';
import {
  buildSandcastleBridgeProcessConfig,
  clearSandcastleLogs,
  decidePromotionPolicy,
  type SandcastlePreview,
  type SandcastlePromotion,
} from '@acp-client/sandcastle';
import { DockerSandboxRuntime, type SubprocessExecutor } from '@acp-client/sandbox';

import { getPipelinePrograms } from '../catalog/pipelineCatalog.js';
import { loadSkillCatalog, renderSkillsCatalog } from '../catalog/skillCatalog.js';
import { loadAgentCatalog } from '../config/config.js';
import { isSandboxConfig, isSandcastleConfig } from '../selection/connectorSelection.js';
import type {
  AgentCatalog,
  AgentConfigEntry,
  WorkspaceRuntimeHost,
  WorkspaceRuntimeOptions,
} from '../types.js';

export interface WorkspaceRuntime {
  readonly programs: readonly CompiledPipelineProgram[];
  readonly runAgent: PipelineAgentRunner;
  clearRunLogs(): void;
}

export interface WorkspaceConnectorOverrides {
  native?: AcpConnector;
  sandcastle?: AcpConnector;
}

export interface CreateWorkspaceRuntimeOptions extends WorkspaceRuntimeOptions {
  connectorOverrides?: WorkspaceConnectorOverrides;
  /** Internal/test seam for already-loaded configuration. */
  resolvedCatalog?: AgentCatalog;
  /** Internal/test seam for exercising Docker Sandbox without a microVM. */
  sandboxExecutor?: SubprocessExecutor;
}

/** Compose workspace discovery, Pipeline V3 adaptation, and connector selection. */
export function createWorkspaceRuntime(options: CreateWorkspaceRuntimeOptions): WorkspaceRuntime {
  const catalog = options.resolvedCatalog ?? loadValidCatalog(options.workspaceCwd);
  const programs = getPipelinePrograms(options.workspaceCwd, options.host.logger);
  const runner = new AcpRunner();
  const sandboxRuntime = new DockerSandboxRuntime(options.sandboxExecutor);

  const runAgent: PipelineAgentRunner = async input => {
    const config = resolveAgent(catalog, input.agentName);
    const sandcastle = isSandcastleConfig(config);
    const sandbox = isSandboxConfig(config);
    if (input.skills && input.skills.length > 0 && config.skills === false) {
      throw new Error(`Pipeline node declares skills but agent "${input.agentName}" has skills disabled.`);
    }
    if (sandbox) {
      const result = await sandboxRuntime.runCodex({
        workspaceCwd: input.workspaceCwd,
        runId: input.runId ?? 'run',
        nodeId: input.nodeId ?? input.agentName,
        attempt: input.attempt ?? 1,
        prompt: input.promptText,
        model: config.model,
        effort: config.effort,
        signal: input.signal,
        workspaceEffects: input.sideEffects === 'workspace',
      });
      return { text: result.stdout, promotion: result.status };
    }
    const processConfig = sandcastle
      ? buildSandcastleBridgeProcessConfig(config, options.workspaceCwd)
      : config;
    const result = await runner.run<PipelinePromotionStatus | undefined>({
      agentName: input.agentName,
      sessionCwd: input.workspaceCwd,
      processConfig,
      prompt: composePrompt(input, options.host.logger),
      connector: sandcastle
        ? options.connectorOverrides?.sandcastle
        : options.connectorOverrides?.native,
      getPermissionContext: options.host.permissionContext,
      autoApprovePermissions: sandcastle || input.permissions === 'allowAll',
      timeouts: catalog.native.pipeline.timeouts,
      signal: input.signal,
      onSessionUpdate: input.onSessionUpdate,
      finalize: sandcastle
        ? context => finishSandcastleRun(context, input, catalog, options.host)
        : undefined,
      logger: options.host.logger,
    });
    return result.finalization
      ? { text: result.text, promotion: result.finalization }
      : { text: result.text };
  };

  return {
    programs,
    runAgent,
    clearRunLogs: () => clearSandcastleLogs(options.workspaceCwd),
  };
}

function loadValidCatalog(workspaceCwd: string): AgentCatalog {
  const catalog = loadAgentCatalog(workspaceCwd);
  if (catalog.errors.length > 0) {
    throw new Error(`Invalid workspace ACP configuration:\n- ${catalog.errors.join('\n- ')}`);
  }
  return catalog;
}

function resolveAgent(catalog: AgentCatalog, agentName: string): AgentConfigEntry {
  const config = catalog.agents[agentName];
  if (!config) {
    throw new Error(`Agent "${agentName}" is not configured in .acp/acp-agents.json or .acp/.sandcastle/config.json.`);
  }
  return config;
}

function composePrompt(input: PipelineAgentRunInput, logger: WorkspaceRuntimeHost['logger']) {
  const renderSkills = (skillNames: readonly string[]): string => {
    if (skillNames.length === 0) return '';
    const catalog = loadSkillCatalog({
      workspaceCwd: input.workspaceCwd,
      logger: (message, error) => logger.error(message, error),
    });
    return renderSkillsCatalog(catalog, [...skillNames], input.workspaceCwd);
  };
  if (input.prompt) return renderAcpPrompt(input.prompt, { renderSkills });
  const skills = input.skills ?? [];
  const skillsBlock = renderSkills(skills);
  return [{
    type: 'text' as const,
    text: skillsBlock ? `${skillsBlock}\n\n${input.promptText}` : input.promptText,
  }];
}

async function finishSandcastleRun(
  context: AcpRunFinalizationContext,
  input: PipelineAgentRunInput,
  catalog: AgentCatalog,
  host: WorkspaceRuntimeHost,
): Promise<PipelinePromotionStatus | undefined> {
  const { connected, sessionId } = context;
  if (input.sideEffects !== 'workspace') {
    await connected.connInfo.connection.extMethod('sandcastle/reject', { sessionId });
    return undefined;
  }
  const response = await connected.connInfo.connection.extMethod('sandcastle/preview', { sessionId });
  const preview: SandcastlePreview = {
    diff: String(response.diff ?? ''),
    filesChanged: Number(response.filesChanged ?? 0),
    branch: String(response.branch ?? ''),
    baseRef: String(response.baseRef ?? ''),
    worktreePath: String(response.worktreePath ?? ''),
  };
  const promotion = mapPipelinePromotionPolicy(input.promotion) ?? catalog.sandcastle.promotion;
  const decision = decidePromotionPolicy(preview, promotion);
  if (decision === 'discard_no_changes') {
    input.onStatus?.({ status: 'implementing', message: 'Sandcastle run produced no text, no tool calls, and no file diff.' });
    await connected.connInfo.connection.extMethod('sandcastle/reject', { sessionId });
    return 'no_changes';
  }
  if (decision === 'auto_reject') {
    await connected.connInfo.connection.extMethod('sandcastle/reject', { sessionId });
    return 'rejected';
  }
  if (decision === 'auto_apply') {
    input.onStatus?.({ status: 'implementing', message: 'Applying Sandcastle changes to the workspace...' });
    return applySandcastleChanges(context);
  }
  input.onStatus?.({
    status: 'implementing',
    message: `Sandcastle changes ready — waiting for promotion (${preview.filesChanged} file(s) changed).`,
  });
  const userDecision = await withTimeout(
    'sandcastle-promotion-ui',
    resolveTimeouts(catalog.native.pipeline.timeouts).promotionUiMs,
    host.requestPromotion({ agentName: input.agentName, sessionId, preview }),
  ).catch(error => {
    if (error instanceof PipelineTimeoutError) return 'cancelled' as const;
    throw error;
  });
  if (userDecision === 'approve') {
    input.onStatus?.({ status: 'implementing', message: 'Applying Sandcastle changes to the workspace...' });
    return applySandcastleChanges(context);
  }
  await connected.connInfo.connection.extMethod('sandcastle/reject', { sessionId });
  return userDecision === 'reject' ? 'rejected' : 'cancelled';
}

async function applySandcastleChanges(context: AcpRunFinalizationContext): Promise<PipelinePromotionStatus> {
  const { connected, sessionId } = context;
  const result = await connected.connInfo.connection.extMethod('sandcastle/apply', { sessionId });
  if (result.success !== true) {
    await connected.connInfo.connection.extMethod('sandcastle/reject', { sessionId });
    throw new Error(String(result.message ?? 'Sandcastle changes could not be applied.'));
  }
  return Number(result.filesChanged ?? 0) === 0 ? 'no_changes' : 'applied';
}

function mapPipelinePromotionPolicy(
  promotion: PipelineAgentRunInput['promotion'],
): SandcastlePromotion | undefined {
  if (promotion === 'ask') return 'ask';
  if (promotion === 'auto-apply') return 'autoApply';
  if (promotion === 'auto-reject' || promotion === 'discard') return 'autoReject';
  return undefined;
}
