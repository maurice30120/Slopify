import { createWorkspaceRuntime, type RuntimePermissionContext } from '@acp-client/workspace';
import type { CliPipelineBackendFactory } from './host.js';

type RuntimeCliPipelineBackendContext = Parameters<CliPipelineBackendFactory>[1] & {
  keepSandboxes?: boolean;
};

interface RetainedSandboxOutput {
  sandboxName: string;
  commands: {
    run: string;
    shell: string;
    remove: string;
  };
  diagnosticsPath?: string;
}

export const createRuntimeCliBackend: CliPipelineBackendFactory = (workspaceCwd, context) => {
  const runtimeContext = context as RuntimeCliPipelineBackendContext;
  const terminalWrite = 'write' in context.terminal && typeof context.terminal.write === 'function'
    ? context.terminal.write.bind(context.terminal)
    : undefined;
  const runtime = createWorkspaceRuntime({
    workspaceCwd,
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
      requestPromotion: async request => {
        const selected = await context.terminal.select(
          [
            `Sandcastle promotion for ${request.agentName}`,
            `Files changed: ${request.preview.filesChanged}`,
            `Branch: ${request.preview.branch || '(unknown)'}`,
            `Base: ${request.preview.baseRef || '(unknown)'}`,
          ].join('\n'),
          ['Apply Sandcastle changes', 'Reject Sandcastle changes'],
        );
        if (selected === 'Apply Sandcastle changes') return 'approve';
        if (selected === 'Reject Sandcastle changes') return 'reject';
        return 'cancelled';
      },
      requestPipelinePromotion: async request => {
        const selected = await context.terminal.select(
          [
            `Pipeline Change Set for ${request.pipelineId}`,
            `Agent checkpoints: ${request.integratedNodeIds.join(', ') || '(none)'}`,
            `Files changed: ${request.preview.fileCount}`,
            `Base: ${request.preview.baseCommit || '(unknown)'}`,
          ].join('\n'),
          ['Apply Pipeline Change Set', 'Reject Pipeline Change Set'],
        );
        if (selected === 'Apply Pipeline Change Set') return 'approve';
        if (selected === 'Reject Pipeline Change Set') return 'reject';
        return 'cancelled';
      },
      logger: context.logger,
    },
  });

  return {
    programs: [...runtime.programs],
    runAgent: runtime.runAgent,
    clearRunLogs: () => runtime.clearRunLogs(),
  };
};

export function formatRetainedSandbox(sandbox: RetainedSandboxOutput): string {
  return [
    `Docker Sandbox kept: ${sandbox.sandboxName}`,
    `Run: ${sandbox.commands.run}`,
    `Shell: ${sandbox.commands.shell}`,
    `Remove: ${sandbox.commands.remove}`,
    ...(sandbox.diagnosticsPath ? [`Diagnostics: ${sandbox.diagnosticsPath}`] : []),
  ].join('\n');
}
