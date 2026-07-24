import * as path from 'node:path';

import {
  orderPipelineNodeIdsForIntegration,
  renderAcpPrompt,
  type CompiledPipelineProgram,
  type PipelineAgentRunInput,
  type PipelineAgentRunner,
  type PipelineChangeSetFinalizationInput,
  type PipelineChangeSetFinalizationResult,
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
import {
  DockerSandboxRuntime,
  GitPromotion,
  createNodeSubprocessExecutor,
  type AgentCheckpointResult,
  type DockerSandboxNetworkPolicyChoice,
  type PromotionDecision,
  type PromotionPolicy,
  type RetainedSandbox,
  type SubprocessExecutor,
} from '@acp-client/sandbox';

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
  /** Point d'injection interne et de test pour une configuration déjà chargée. */
  resolvedCatalog?: AgentCatalog;
  /** Point d'injection interne et de test pour exercer Docker Sandbox sans microVM. */
  sandboxExecutor?: SubprocessExecutor;
  /** Preserve every Docker Sandbox created by this runtime. */
  keepSandboxes?: boolean;
  /** Report a retained sandbox after its diagnostics have been exported. */
  onSandboxRetained?: (sandbox: RetainedSandbox) => void | Promise<void>;
}

/**
 * Maintient la frontière entre découverte du workspace, adaptation Pipeline V3
 * et sélection du connecteur. Le pipeline reste ainsi indépendant de la CLI
 * Docker et des détails propres aux runtimes d'agents.
 *
 * Voir `docs/adr/0003-keep-acp-as-the-sandbox-runtime-boundary.md`.
 */
export function createWorkspaceRuntime(options: CreateWorkspaceRuntimeOptions): WorkspaceRuntime {
  const catalog = options.resolvedCatalog ?? loadValidCatalog(options.workspaceCwd);
  const programs = getPipelinePrograms(options.workspaceCwd, options.host.logger);
  const runner = new AcpRunner();
  const sandboxRuntime = new DockerSandboxRuntime(options.sandboxExecutor, {
    selectNetworkPolicy: choices => selectSandboxNetworkPolicy(options.host, choices),
    reportNetworkPolicy: message => options.host.permissionContext()?.ui.write?.(message),
  });
  // Toutes les tentatives sont conservées jusqu'à la finalisation : un retry
  // remplace uniquement le checkpoint du même nœud, sans toucher aux résultats
  // valides des autres agents.
  const checkpointsByRunId = new Map<string, Map<string, Map<number, AgentCheckpointResult>>>();

  const runAgent = (async input => {
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
        timeoutMs: resolveTimeouts(catalog.native.pipeline.timeouts).promptMs,
        workspaceEffects: input.sideEffects === 'workspace',
        keepSandbox: options.keepSandboxes,
        diagnosticsDirectory: path.join(input.workspaceCwd, '.acp', 'logs', 'sandboxes'),
        onSandboxRetained: options.onSandboxRetained,
      });
      if (input.sideEffects === 'workspace') {
        const runId = input.runId ?? 'run';
        const nodeId = input.nodeId ?? input.agentName;
        const attempt = input.attempt ?? 1;
        const checkpoints = checkpointsByRunId.get(runId)
          ?? new Map<string, Map<number, AgentCheckpointResult>>();
        const attempts = checkpoints.get(nodeId) ?? new Map<number, AgentCheckpointResult>();
        attempts.set(attempt, {
          checkpointStatus: result.checkpointStatus,
          checkpoint: result.checkpoint,
          preview: result.preview,
        });
        checkpoints.set(nodeId, attempts);
        checkpointsByRunId.set(runId, checkpoints);
      }
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
  }) as PipelineAgentRunner;

  runAgent.finalizePipelineChangeSet = input => finalizePipelineChangeSet({
    input,
    checkpointsByRunId,
    workspaceCwd: options.workspaceCwd,
    host: options.host,
    execute: options.sandboxExecutor,
  });

  return {
    programs,
    runAgent,
    clearRunLogs: () => clearSandcastleLogs(options.workspaceCwd),
  };
}

interface FinalizePipelineChangeSetOptions {
  input: PipelineChangeSetFinalizationInput;
  checkpointsByRunId: Map<string, Map<string, Map<number, AgentCheckpointResult>>>;
  workspaceCwd: string;
  host: WorkspaceRuntimeHost;
  execute?: SubprocessExecutor;
}

async function finalizePipelineChangeSet(
  options: FinalizePipelineChangeSetOptions,
): Promise<PipelineChangeSetFinalizationResult> {
  const { input } = options;
  const checkpoints = options.checkpointsByRunId.get(input.runId);
  if (!checkpoints || checkpoints.size === 0) {
    return {
      promotion: 'no_changes',
      preview: {
        baseCommit: '',
        changeSetCommit: '',
        fileCount: 0,
        files: [],
        diff: '',
      },
      integratedNodeIds: [],
    };
  }

  try {
    const orderedNodeIds = orderPipelineNodeIdsForIntegration(input.program, checkpoints.keys());
    const selectedCheckpoints = new Map<string, AgentCheckpointResult>();
    const supersededCheckpoints: AgentCheckpointResult[] = [];
    // Seule la tentative la plus récente de chaque nœud contribue au Pipeline
    // Change Set. Les refs plus anciennes sont supprimées avant l'intégration
    // pour éviter qu'une reprise ne réutilise un résultat obsolète.
    for (const nodeId of orderedNodeIds) {
      const attempts = checkpoints.get(nodeId)!;
      const attemptNumbers = [...attempts.keys()].sort((left, right) => left - right);
      const highestAttempt = attemptNumbers.at(-1)!;
      selectedCheckpoints.set(nodeId, attempts.get(highestAttempt)!);
      for (const attempt of attemptNumbers.slice(0, -1)) {
        supersededCheckpoints.push(attempts.get(attempt)!);
      }
    }
    const orderedCheckpoints = orderedNodeIds.map(nodeId => selectedCheckpoints.get(nodeId)!);
    const policy = resolvePipelinePromotionPolicy(input.program, orderedNodeIds);
    const gitPromotion = new GitPromotion(options.execute ?? createNodeSubprocessExecutor());
    await gitPromotion.deleteAgentCheckpoints(options.workspaceCwd, supersededCheckpoints);
    const changeSet = await gitPromotion.integrateAgentCheckpoints({
      workspaceCwd: options.workspaceCwd,
      runId: input.runId,
      checkpoints: orderedCheckpoints,
    });
    const promoted = await gitPromotion.promotePipelineChangeSet({
      workspaceCwd: options.workspaceCwd,
      policy,
      changeSet: changeSet.changeSet,
      preview: changeSet.preview,
      decide: policy === 'ask'
        ? request => decidePipelinePromotion(options.host, input, request.preview, request.changeSet.integratedNodeIds)
        : undefined,
    });
    return {
      promotion: promoted.status,
      preview: promoted.preview,
      changeSetRef: promoted.changeSet.ref,
      changeSetCommit: promoted.changeSet.commit,
      integratedNodeIds: promoted.changeSet.integratedNodeIds,
    };
  } finally {
    options.checkpointsByRunId.delete(input.runId);
  }
}

function resolvePipelinePromotionPolicy(
  program: CompiledPipelineProgram,
  nodeIds: readonly string[],
): PromotionPolicy {
  // La Promotion porte sur le Pipeline Change Set complet : des politiques par
  // nœud contradictoires rendraient impossible une décision finale atomique.
  // Voir `docs/adr/0004-make-promotion-a-pipeline-policy.md`.
  const policies = new Set(nodeIds.map(nodeId => program.nodesById.get(nodeId)!.policy.promotion));
  if (policies.size > 1) {
    throw new Error(`Workspace-writing nodes declare conflicting Promotion policies: ${[...policies].join(', ')}. A multi-agent Pipeline Change Set requires one policy.`);
  }
  return [...policies][0] ?? 'discard';
}

async function decidePipelinePromotion(
  host: WorkspaceRuntimeHost,
  input: PipelineChangeSetFinalizationInput,
  preview: PipelineChangeSetFinalizationResult['preview'],
  integratedNodeIds: string[],
): Promise<PromotionDecision> {
  if (!host.requestPipelinePromotion) {
    return 'cancel';
  }
  const decision = await host.requestPipelinePromotion({
    runId: input.runId,
    pipelineId: input.program.id,
    integratedNodeIds,
    preview,
  });
  if (decision === 'approve') return 'apply';
  if (decision === 'reject') return 'reject';
  return 'cancel';
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

async function selectSandboxNetworkPolicy(
  host: WorkspaceRuntimeHost,
  choices: readonly DockerSandboxNetworkPolicyChoice[],
): Promise<DockerSandboxNetworkPolicyChoice | undefined> {
  const permissionContext = host.permissionContext();
  if (!permissionContext?.hasUI) {
    return undefined;
  }
  const selected = await permissionContext.ui.select(
    'Docker Sandbox global network policy is not initialized. Choose the policy inherited by every Sandbox Run:',
    [...choices],
  );
  return choices.find(choice => choice === selected);
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
