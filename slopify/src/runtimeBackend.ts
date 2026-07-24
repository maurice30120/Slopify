import { createWorkspaceRuntime, type RuntimePermissionContext } from '@acp-client/workspace';
import type { CliPipelineBackendFactory } from './host.js';

export const createRuntimeCliBackend: CliPipelineBackendFactory = (workspaceCwd, context) => {
  const runtime = createWorkspaceRuntime({ workspaceCwd, host: {
    permissionContext: (): RuntimePermissionContext => ({
      hasUI: true,
      ui: {
        select: (title, options) => context.terminal.select(title, options),
        confirm: (title, message) => context.terminal.confirm(title, message),
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
  }});

  return {
    programs: [...runtime.programs],
    runAgent: runtime.runAgent,
    clearRunLogs: () => runtime.clearRunLogs(),
  };
};
