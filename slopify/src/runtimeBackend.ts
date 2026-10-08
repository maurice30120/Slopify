import { createWorkspaceRuntime, type RuntimePermissionContext } from '@acp-client/workspace';
import type { CliPipelineBackendFactory } from './host.js';

type RuntimeCliPipelineBackendContext = Parameters<CliPipelineBackendFactory>[1] & {
  keepSandboxes?: boolean;
};

/** Contrat fonctionnel de RetainedSandboxOutput dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
interface RetainedSandboxOutput {
  sandboxName: string;
  commands: {
    run: string;
    shell: string;
    remove: string;
  };
  diagnosticsPath?: string;
}

/** Constante createRuntimeCliBackend qui fixe un contrat partagé du pipeline. */
export const createRuntimeCliBackend: CliPipelineBackendFactory = (workspaceCwd, context) => {
  const runtimeContext = context as RuntimeCliPipelineBackendContext;
  const terminalWrite = 'write' in context.terminal && typeof context.terminal.write === 'function'
    ? context.terminal.write.bind(context.terminal)
    : undefined;
  const runtime = createWorkspaceRuntime({
    workspaceCwd,
    agentName: runtimeContext.agentName,
    keepSandboxes: runtimeContext.keepSandboxes,
    onSandboxRetained: sandbox => context.logger.error(formatRetainedSandbox(sandbox)),
    host: {
      permissionContext: (): RuntimePermissionContext => ({
        hasUI: true,
        ui: {
          select: (title, options) => context.terminal.select(title, options),
          confirm: (title, message) => context.terminal.confirm(title, message),
          ...(terminalWrite ? { write: terminalWrite } : {}),
        },
      }),
      requestPipelinePromotion: async request => {
        const selected = await context.terminal.select(
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
          formatPipelineChangeSetPrompt(request),
          ['Promote Pipeline Change Set', 'Reject Pipeline Change Set'],
        );
        if (selected === 'Promote Pipeline Change Set') return 'approve';
        if (selected === 'Reject Pipeline Change Set') return 'reject';
        return 'cancelled';
      },
      logger: context.logger,
    },
  });

  return {
    programs: [...runtime.programs],
    preflightPipeline: (program, runId) => runtime.preflightPipeline(program, runId),
    runAgent: runtime.runAgent,
    clearRunLogs: () => runtime.clearRunLogs(),
  };
};

/** Point d'entrée formatPipelineChangeSetPrompt du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
export function formatPipelineChangeSetPrompt(request: {
  pipelineId: string;
  integratedNodeIds: readonly string[];
  preview: {
    baseCommit: string;
    changeSetCommit: string;
    fileCount: number;
    files: readonly string[];
    diff: string;
  };
}): string {
  return [
    `Pipeline Change Set for ${request.pipelineId}`,
    `Agent checkpoints: ${request.integratedNodeIds.join(', ') || '(none)'}`,
    `Files changed: ${request.preview.fileCount}`,
    ...request.preview.files.map(file => `- ${file}`),
    `Base: ${request.preview.baseCommit || '(unknown)'}`,
    '',
    'Diff:',
    request.preview.diff || '(no diff)',
  ].join('\n');
}

/** Point d'entrée formatRetainedSandbox du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
export function formatRetainedSandbox(sandbox: RetainedSandboxOutput): string {
  return [
    `Docker Sandbox kept: ${sandbox.sandboxName}`,
    `Run: ${sandbox.commands.run}`,
    `Shell: ${sandbox.commands.shell}`,
    `Remove: ${sandbox.commands.remove}`,
    ...(sandbox.diagnosticsPath ? [`Diagnostics: ${sandbox.diagnosticsPath}`] : []),
  ].join('\n');
}
