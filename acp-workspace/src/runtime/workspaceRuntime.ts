import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  mapPolicyToLegacySideEffects,
  orderPipelineNodeIdsForIntegration,
  PipelineIntegrationConflictError,
  renderAcpPrompt,
  type CompiledPipelineProgram,
  type PipelineAgentRunInput,
  type PipelineAgentRunner,
  type PipelineChangeSetFinalizationInput,
  type PipelineChangeSetFinalizationResult,
  type PipelinePromotionStatus,
  PipelineSandboxResumeDivergenceError,
  type PipelineRuntimeSnapshot,
  type PipelineSandboxRunSnapshot,
} from '@acp-client/pipeline';
import {
  AcpRunner,
  createInMemoryAcpConnector,
  resolveTimeouts,
  type AcpConnector,
} from '@acp-client/runtime';
import {
  DockerSandboxAcpBridgeAgent,
  DockerSandboxRuntime,
  GitPromotion,
  IntegrationConflictError,
  SandboxAcpExtensionHandler,
  SandboxAcpExtensionAgent,
  createNodeSubprocessExecutor,
  stableSandboxName,
  type AgentCheckpointResult,
  type DockerSandboxNetworkPolicyChoice,
  type IntegrateAgentCheckpointsInput,
  type IntegrationConflict,
  type PipelineChangeSetResult,
  type PromotionDecision,
  type PromotePipelineChangeSetInput,
  type PromotionResult,
  type RetainedSandbox,
  type SandboxReconciliationResult,
  type SandboxResumeSnapshot,
  type SandboxBridgePreviewResponse,
  type SandboxRunState,
  type SubprocessExecutor,
} from '@acp-client/sandbox';

import { getPipelinePrograms } from '../catalog/pipelineCatalog.js';
import { loadSkillCatalog, renderSkillsCatalog } from '../catalog/skillCatalog.js';
import { loadAgentCatalog } from '../config/config.js';
import type {
  AgentCatalog,
  AgentConfigEntry,
  WorkspaceRuntimeHost,
  WorkspaceRuntimeOptions,
} from '../types.js';

/** Contrat fonctionnel de WorkspaceRuntime dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface WorkspaceRuntime {
  readonly programs: readonly CompiledPipelineProgram[];
  readonly runAgent: PipelineAgentRunner;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  preflightPipeline(program: CompiledPipelineProgram, runId: string): Promise<void>;
/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  clearRunLogs(): void;
}

/** Contrat fonctionnel de WorkspaceConnectorOverrides dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface WorkspaceConnectorOverrides {
  native?: AcpConnector;
}

/** Contrat fonctionnel de CreateWorkspaceRuntimeOptions dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface CreateWorkspaceRuntimeOptions extends WorkspaceRuntimeOptions {
  connectorOverrides?: WorkspaceConnectorOverrides;
  /** Point d'injection interne et de test pour une configuration déjà chargée. */
  resolvedCatalog?: AgentCatalog;
  /** Point d'injection interne et de test pour exercer Docker Sandbox sans microVM. */
  sandboxExecutor?: SubprocessExecutor;
  /** Conserve chaque Docker Sandbox créé par ce runtime pour le diagnostic du run. */
  keepSandboxes?: boolean;
  /** Signale une sandbox conservée après l'export de ses diagnostics. */
  onSandboxRetained?: (sandbox: RetainedSandbox) => void | Promise<void>;
}

/**
 * Compose le runtime du workspace, le catalogue d'agents et la frontière Docker Sandbox.
 * Les nœuds d'écriture produisent des Agent Checkpoints ; la Promotion du Pipeline Change Set
 * reste déléguée à la politique du pipeline et à l'hôte.
 * @param options Configuration du workspace, hôte, agent et connecteurs de test.
 * @returns Une façade de runtime utilisable par la CLI ou un hôte d'intégration.
 * @throws Error si le catalogue d'agents ou les politiques du workspace sont invalides.
 */
export function createWorkspaceRuntime(options: CreateWorkspaceRuntimeOptions): WorkspaceRuntime {
  const catalog = options.resolvedCatalog ?? loadValidCatalog(options.workspaceCwd);
  if (options.agentName) {
/** Valide ou résout les données de cette étape du cycle de vie ; les entrées invalides restent signalées au point d'appel. */
    resolveAgent(catalog, options.agentName);
  }
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
    const sandbox = config.transport === 'sandbox';
    if (input.skills && input.skills.length > 0 && config.skills === false) {
      throw new Error(`Pipeline node declares skills but agent "${input.agentName}" has skills disabled.`);
    }
    if (sandbox) {
      const acpResult = await runner.run<SandboxBridgePreviewResponse>({
        agentName: input.agentName,
        sessionCwd: input.workspaceCwd,
        processConfig: { command: process.execPath },
        prompt: composePrompt(input, options.host.logger),
        connector: createInMemoryAcpConnector(connection => new DockerSandboxAcpBridgeAgent(
          connection,
          sandboxRuntime,
          {
          runId: input.runId ?? 'run',
          nodeId: input.nodeId ?? input.agentName,
          attempt: input.attempt ?? 1,
          agent: config.agent,
          model: config.model,
          effort: config.effort,
          timeoutMs: resolveTimeouts(catalog.config.pipeline.timeouts).promptMs,
          workspaceEffects: input.sideEffects === 'workspace',
          keepSandbox: options.keepSandboxes,
          diagnosticsDirectory: path.join(input.workspaceCwd, '.acp', 'logs', 'sandboxes'),
          onSandboxRetained: options.onSandboxRetained,
          onStateChange: state => input.onSandboxRunState?.(toPipelineSandboxRunSnapshot(state)),
          ...(input.resumeSandboxRun ? { resumeState: toSandboxRunState(input.resumeSandboxRun) } : {}),
          ...(input.dependencyCheckpoints?.length ? {
            dependencyCheckpoints: input.dependencyCheckpoints.map(toAgentCheckpointResult),
          } : {}),
          },
        )),
        getPermissionContext: options.host.permissionContext,
        timeouts: catalog.config.pipeline.timeouts,
        signal: input.signal,
        onSessionUpdate: input.onSessionUpdate,
        finalize: ({ connected, sessionId }) => connected.connInfo.connection.extMethod(
          'sandbox/preview',
          { sessionId },
        ) as Promise<unknown> as Promise<SandboxBridgePreviewResponse>,
        logger: options.host.logger,
      });
      if (!acpResult.finalization.ok) {
        const failure = acpResult.finalization.error;
        if (failure.code === 'integration_conflict' && failure.conflict) {
          throw toPipelineIntegrationConflict(failure.conflict, input.nodeId ?? input.agentName);
        }
        if (failure.code === 'sandbox_resume_divergence' && input.resumeSandboxRun) {
          throw new PipelineSandboxResumeDivergenceError({
            runId: input.runId ?? 'run',
            sandboxName: input.resumeSandboxRun.sandboxName,
            nodeId: input.nodeId ?? input.agentName,
            attempt: input.attempt ?? 1,
            diagnostic: failure.diagnostic ?? failure.message,
          });
        }
        throw new Error(failure.message);
      }
      const result = acpResult.finalization.result;
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
      return { text: acpResult.text, promotion: result.status };
    }
    const result = await runner.run<PipelinePromotionStatus | undefined>({
      agentName: input.agentName,
      sessionCwd: input.workspaceCwd,
      processConfig: config,
      prompt: composePrompt(input, options.host.logger),
      connector: options.connectorOverrides?.native,
      getPermissionContext: options.host.permissionContext,
      autoApprovePermissions: input.permissions === 'allowAll',
      timeouts: catalog.config.pipeline.timeouts,
      signal: input.signal,
      onSessionUpdate: input.onSessionUpdate,
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
    sandboxRuntime,
  });

  return {
    programs,
    runAgent,
    preflightPipeline: async (program, runId) => {
      const plannedSandboxNames = program.nodes.flatMap(node => {
        if (node.kind !== 'agent') return [];
        if (!node.agent) {
          throw new Error(`Pipeline node "${node.id}" has no selected ACP agent.`);
        }
        const config = resolveAgent(catalog, node.agent);
        if (config.transport === 'sandbox' && node.policy.network === 'enabled') {
          throw new Error(`node "${node.id}" network policy is not supported for Docker Sandbox Runs; configure the global policy with "sbx policy".`);
        }
        if (mapPolicyToLegacySideEffects(node.policy) !== 'workspace' || config.transport !== 'sandbox') {
          return [];
        }
        return [stableSandboxName(runId, node.id, 1)];
      });
      if (plannedSandboxNames.length > 0) {
        await sandboxRuntime.preflightWorkspace(
          options.workspaceCwd,
          true,
          undefined,
          plannedSandboxNames,
        );
      }
    },
    clearRunLogs: () => fs.rmSync(path.join(options.workspaceCwd, '.acp', 'logs', 'sandboxes'), { recursive: true, force: true }),
  };
}

/** Point d'entrée toAgentCheckpointResult du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function toAgentCheckpointResult(dependency: NonNullable<PipelineAgentRunInput['dependencyCheckpoints']>[number]): AgentCheckpointResult {
  return {
    checkpointStatus: dependency.checkpoint.status,
    checkpoint: {
      runId: dependency.runId,
      nodeId: dependency.nodeId,
      attempt: dependency.attempt,
      sandboxName: dependency.sandboxName,
      baseCommit: dependency.baseCommit,
      commit: dependency.checkpoint.commit,
      remote: dependency.checkpoint.remote,
      ref: dependency.checkpoint.ref,
    },
    preview: dependency.checkpoint.preview,
  };
}

/** Contrat fonctionnel de FinalizePipelineChangeSetOptions dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
interface FinalizePipelineChangeSetOptions {
  input: PipelineChangeSetFinalizationInput;
  checkpointsByRunId: Map<string, Map<string, Map<number, AgentCheckpointResult>>>;
  workspaceCwd: string;
  host: WorkspaceRuntimeHost;
  execute?: SubprocessExecutor;
  sandboxRuntime: DockerSandboxRuntime;
}

async function finalizePipelineChangeSet(
  options: FinalizePipelineChangeSetOptions,
): Promise<PipelineChangeSetFinalizationResult> {
  const { input } = options;
  const gitPromotion = new GitPromotion(options.execute ?? createNodeSubprocessExecutor());
  const extensions = createSandboxExtensionHandler(options.sandboxRuntime, gitPromotion);
  const durableRuns = Object.values(input.snapshot?.sandboxRuns ?? {})
    .filter(run => run.runId === input.runId);
  for (const run of durableRuns) {
    if (run.resourceState === 'removed') continue;
    const reconciled = await callSandboxExtension<SandboxResumeSnapshot, SandboxReconciliationResult>(
      extensions,
      'sandbox/status',
      {
        workspaceCwd: options.workspaceCwd,
        sandboxName: run.sandboxName,
        sandboxId: run.sandboxId,
        baseCommit: run.baseCommit,
        checkpointCommit: run.checkpoint?.commit,
      },
    );
    if (reconciled.status === 'diverged') {
      throw new PipelineSandboxResumeDivergenceError({
        runId: input.runId,
        sandboxName: run.sandboxName,
        nodeId: run.nodeId,
        attempt: run.attempt,
        diagnostic: reconciled.diagnostic,
      });
    }
  }
  const durableCheckpoints = checkpointsFromSnapshot(input.snapshot, input.runId, input.program);
  const checkpoints = durableCheckpoints.size > 0
    ? durableCheckpoints
    : options.checkpointsByRunId.get(input.runId);
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

  const orderedNodeIds = orderPipelineNodeIdsForIntegration(input.program, checkpoints.keys());
  const selectedCheckpoints = new Map<string, AgentCheckpointResult>();
  const supersededCheckpoints: AgentCheckpointResult[] = [];
  // Seule la tentative la plus récente de chaque nœud contribue au Pipeline
  // Change Set. Les refs plus anciennes ne deviennent obsolètes qu'après une
  // intégration réussie, afin qu'un conflit reste entièrement retentable.
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
  const policy = input.program.promotion;
  try {
    const changeSet = await callSandboxExtension<IntegrateAgentCheckpointsInput, PipelineChangeSetResult>(
      extensions,
      'sandbox/preview',
      {
      workspaceCwd: options.workspaceCwd,
      runId: input.runId,
      checkpoints: orderedCheckpoints,
      },
    );
    await gitPromotion.deleteAgentCheckpoints(options.workspaceCwd, supersededCheckpoints);
    const promotionRequest: PromotePipelineChangeSetInput = {
      workspaceCwd: options.workspaceCwd,
      policy,
      changeSet: changeSet.changeSet,
      preview: changeSet.preview,
      decide: policy === 'ask'
        ? request => decidePipelinePromotion(options.host, input, request.preview, request.changeSet.integratedNodeIds)
        : undefined,
    };
    const promoted = await callSandboxExtension<PromotePipelineChangeSetInput, PromotionResult>(
      extensions,
      policy === 'discard' || policy === 'auto-reject' ? 'sandbox/reject' : 'sandbox/promote',
      promotionRequest,
    );
    const result = {
      promotion: promoted.status,
      preview: promoted.preview,
      changeSetRef: promoted.changeSet.ref,
      changeSetCommit: promoted.changeSet.commit,
      integratedNodeIds: promoted.changeSet.integratedNodeIds,
    };
    options.checkpointsByRunId.delete(input.runId);
    return result;
  } catch (error: unknown) {
    if (error instanceof IntegrationConflictError) {
      throw toPipelineIntegrationConflict(error.conflict, error.conflict.incomingCheckpoint.nodeId);
    }
    // Seul l'état volatil est supprimé. Les refs durables et les checkpoints du snapshot restent
    // disponibles pour une reprise déterministe après un redémarrage du processus.
    if (input.snapshot) options.checkpointsByRunId.delete(input.runId);
    throw error;
  }
}

/** Point d'entrée toPipelineIntegrationConflict du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function toPipelineIntegrationConflict(
  conflict: IntegrationConflict,
  retryNodeId: string,
): PipelineIntegrationConflictError {
  return new PipelineIntegrationConflictError({
    runId: conflict.runId,
    retryNodeId,
    checkpoints: conflict.checkpoints.map(checkpoint => ({
      nodeId: checkpoint.nodeId,
      attempt: checkpoint.attempt,
      commit: checkpoint.commit,
      ref: checkpoint.ref,
    })),
    files: conflict.files,
  });
}

/** Point d'entrée createSandboxExtensionHandler du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function createSandboxExtensionHandler(
  runtime: DockerSandboxRuntime,
  promotion: GitPromotion,
): SandboxAcpExtensionHandler {
  return new SandboxAcpExtensionHandler({
    'sandbox/status': async params => toExtensionRecord(
      await runtime.reconcileSandbox(params as unknown as SandboxResumeSnapshot),
    ),
    'sandbox/preview': async params => toExtensionRecord(
      await promotion.integrateAgentCheckpoints(params as unknown as IntegrateAgentCheckpointsInput),
    ),
    'sandbox/promote': async params => toExtensionRecord(
      await promotion.promotePipelineChangeSet(params as unknown as PromotePipelineChangeSetInput),
    ),
    'sandbox/reject': async params => {
      const request = params as unknown as PromotePipelineChangeSetInput;
      return toExtensionRecord(await promotion.promotePipelineChangeSet({
        ...request,
        policy: 'auto-reject',
        decide: undefined,
      }));
    },
  });
}

async function callSandboxExtension<TRequest, TResponse>(
  handler: SandboxAcpExtensionHandler,
  method: 'sandbox/status' | 'sandbox/preview' | 'sandbox/promote' | 'sandbox/reject',
  request: TRequest,
): Promise<TResponse> {
  const requestHandler = new SandboxAcpExtensionHandler({
    [method]: async () => {
      try {
        return {
          ok: true,
          value: await handler.extMethod(method, request as Record<string, unknown>),
        };
      } catch (error: unknown) {
        if (error instanceof IntegrationConflictError) {
          return {
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              conflict: error.conflict,
            },
          };
        }
        return {
          ok: false,
          error: {
            code: error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string'
              ? (error as Error & { code: string }).code
              : 'sandbox_extension_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  });
  const acpResult = await new AcpRunner().run<Record<string, unknown>>({
    agentName: 'Docker Sandbox lifecycle bridge',
    sessionCwd: typeof (request as { workspaceCwd?: unknown }).workspaceCwd === 'string'
      ? (request as { workspaceCwd: string }).workspaceCwd
      : process.cwd(),
    processConfig: { command: process.execPath },
    prompt: [{ type: 'text', text: `Invoke ${method}.` }],
    connector: createInMemoryAcpConnector(() => new SandboxAcpExtensionAgent(requestHandler)),
    finalize: ({ connected, sessionId }) => connected.connInfo.connection.extMethod(method, { sessionId }),
  });
  const envelope = acpResult.finalization as {
    ok: boolean;
    value?: Record<string, unknown>;
    error?: { code: string; message: string; conflict?: IntegrationConflict };
  };
  if (envelope.ok && envelope.value) return envelope.value as unknown as TResponse;
  if (envelope.error?.code === 'integration_conflict' && envelope.error.conflict) {
    throw new IntegrationConflictError(envelope.error.conflict);
  }
  const error = new Error(envelope.error?.message ?? `Sandbox ACP extension ${method} failed.`);
  Object.assign(error, { code: envelope.error?.code ?? 'sandbox_extension_failed' });
  throw error;
}

/** Point d'entrée toExtensionRecord du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function toExtensionRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** Point d'entrée toPipelineSandboxRunSnapshot du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function toPipelineSandboxRunSnapshot(state: SandboxRunState): PipelineSandboxRunSnapshot {
  return {
    sandboxName: state.sandboxName,
    ...(state.sandboxId ? { sandboxId: state.sandboxId } : {}),
    runId: state.runId,
    nodeId: state.nodeId,
    attempt: state.attempt,
    baseCommit: state.baseCommit,
    integrationState: state.integrationState,
    resourceState: state.resourceState,
    ...(state.diagnosticsPath ? { diagnosticsPath: state.diagnosticsPath } : {}),
    ...(state.stdout !== undefined ? { output: state.stdout } : {}),
    ...(state.checkpoint ? {
      checkpoint: {
        status: state.checkpoint.checkpointStatus,
        commit: state.checkpoint.checkpoint.commit,
        remote: state.checkpoint.checkpoint.remote,
        ref: state.checkpoint.checkpoint.ref,
        preview: state.checkpoint.preview,
      },
    } : {}),
  };
}

/** Point d'entrée toSandboxRunState du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function toSandboxRunState(state: PipelineSandboxRunSnapshot): SandboxRunState {
  return {
    sandboxName: state.sandboxName,
    ...(state.sandboxId ? { sandboxId: state.sandboxId } : {}),
    runId: state.runId,
    nodeId: state.nodeId,
    attempt: state.attempt,
    baseCommit: state.baseCommit,
    integrationState: state.checkpoint ? 'checkpointed' : 'sandbox_created',
    resourceState: state.resourceState,
    ...(state.output !== undefined ? { stdout: state.output } : {}),
    ...(state.diagnosticsPath ? { diagnosticsPath: state.diagnosticsPath } : {}),
    ...(state.checkpoint ? {
      checkpoint: {
        checkpointStatus: state.checkpoint.status,
        checkpoint: {
          runId: state.runId,
          nodeId: state.nodeId,
          attempt: state.attempt,
          sandboxName: state.sandboxName,
          baseCommit: state.baseCommit,
          commit: state.checkpoint.commit,
          remote: state.checkpoint.remote,
          ref: state.checkpoint.ref,
        },
        preview: state.checkpoint.preview,
      },
    } : {}),
  };
}

/** Point d'entrée checkpointsFromSnapshot du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function checkpointsFromSnapshot(
  snapshot: PipelineRuntimeSnapshot | undefined,
  runId: string,
  program: CompiledPipelineProgram,
): Map<string, Map<number, AgentCheckpointResult>> {
  const checkpoints = new Map<string, Map<number, AgentCheckpointResult>>();
  for (const run of Object.values(snapshot?.sandboxRuns ?? {})) {
    if (
      run.runId !== runId
      || !run.checkpoint
      || !program.nodesById.has(run.nodeId)
      || mapPolicyToLegacySideEffects(program.nodesById.get(run.nodeId)!.policy) !== 'workspace'
    ) continue;
    const attempts = checkpoints.get(run.nodeId) ?? new Map<number, AgentCheckpointResult>();
    attempts.set(run.attempt, {
      checkpointStatus: run.checkpoint.status,
      checkpoint: {
        runId: run.runId,
        nodeId: run.nodeId,
        attempt: run.attempt,
        sandboxName: run.sandboxName,
        baseCommit: run.baseCommit,
        commit: run.checkpoint.commit,
        remote: run.checkpoint.remote,
        ref: run.checkpoint.ref,
      },
      preview: run.checkpoint.preview,
    });
    checkpoints.set(run.nodeId, attempts);
  }
  return checkpoints;
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

/** Point d'entrée loadValidCatalog du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function loadValidCatalog(workspaceCwd: string): AgentCatalog {
  const catalog = loadAgentCatalog(workspaceCwd);
  if (catalog.errors.length > 0) {
    throw new Error(`Invalid workspace ACP configuration:\n- ${catalog.errors.join('\n- ')}`);
  }
  return catalog;
}

/** Point d'entrée resolveAgent du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function resolveAgent(catalog: AgentCatalog, agentName: string): AgentConfigEntry {
  const config = catalog.agents[agentName];
  if (!config) {
    throw new Error(`Agent "${agentName}" is not configured in .acp/acp-agents.json.`);
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

/** Point d'entrée composePrompt du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
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
