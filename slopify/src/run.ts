import {
  createWorkspaceRun,
  type WorkspaceArtifact,
  type WorkspaceRunInteraction,
} from '@acp-client/workspace';

import type { CliResumeCommand, CliRunCommand } from './args.js';
import type { CliPipelineHost, CliPipelineListEntry } from './host.js';
import type { CliTerminal } from './terminal.js';

export interface CliRunResult {
  status: 'completed' | 'rejected' | 'cancelled' | 'failed';
  runId: string;
  artifact?: WorkspaceArtifact;
  error?: { code: string; message: string; nodeId?: string; attempt?: number };
}

export async function runPipelineInteractive(
  host: Pick<CliPipelineHost, 'start' | 'resume'> & Partial<Pick<CliPipelineHost, 'recover'>>,
  terminal: CliTerminal,
  command: CliRunCommand | CliResumeCommand,
): Promise<CliRunResult> {
  const workspaceRun = createWorkspaceRun({
    workspaceCwd: command.cwd,
    start: (pipelineName, prompt) => host.start(pipelineName, prompt),
    ...(host.recover ? { recover: runId => host.recover!(runId) } : {}),
    resume: (runId, decision) => host.resume(runId, decision),
    onDeliveryProgress: message => terminal.writeError(`[slopify] ${message}`),
  });
  let result = command.kind === 'resume'
    ? await workspaceRun.recover(command.runId)
    : await workspaceRun.start(command.pipelineName, command.prompt);

  while (result.status === 'interaction-required') {
    const interaction = result.interaction;
    if (!command.json) terminal.write(formatInteraction(interaction));

    if (interaction.kind === 'question') {
      const answer = await askForAnswer(terminal);
      result = await workspaceRun.respond(result.runId, {
        interactionId: interaction.id,
        ...(answer === '/done'
          ? { kind: 'complete-interview' as const }
          : { kind: 'answer' as const, value: answer }),
      });
      continue;
    }

    // `--yes` automatise les pauses ordinaires, jamais une Promotion : celle-ci
    // constitue l'unique mutation atomique du workspace et exige donc toujours
    // une décision explicite de l'utilisateur.
    const approved = interaction.kind === 'approval' && command.yes
      ? true
      : await terminal.confirm(
        interaction.kind === 'promotion' ? 'Approve pipeline promotion?' : 'Approve pipeline pause?',
        interaction.kind === 'promotion'
          ? 'This decision may promote isolated workspace changes.'
          : undefined,
      );

    result = await workspaceRun.respond(result.runId, approved
      ? { interactionId: interaction.id, kind: 'approve' }
      : { interactionId: interaction.id, kind: 'reject' });
  }

  const final: CliRunResult = result;
  if (command.json) {
    terminal.write(JSON.stringify(final, null, 2));
  } else if (final.status === 'completed') {
    const output = stringifyArtifact(final.artifact);
    if (output) {
      terminal.write(output);
    }
  } else if (final.status === 'failed') {
    terminal.writeError(formatFailure(final.error));
  } else if (final.status === 'rejected') {
    terminal.writeError('Pipeline Change Set rejected.');
  } else {
    terminal.writeError('Pipeline cancelled.');
  }
  return final;
}

export function formatPipelineList(entries: CliPipelineListEntry[], json: boolean): string {
  if (json) {
    return JSON.stringify(entries, null, 2);
  }
  if (entries.length === 0) {
    return 'No valid ACP version 3 pipelines found in .acp/pipelines.';
  }
  return entries.map(entry => `- ${entry.id} — ${entry.title} (${entry.nodeCount} nodes)`).join('\n');
}

function formatFailure(error: CliRunResult['error']): string {
  const code = error?.code ?? 'unknown';
  const location = error?.nodeId ? ` at node "${error.nodeId}"` : '';
  const attempt = error?.attempt !== undefined ? ` attempt ${error.attempt}` : '';
  const message = error?.message ?? 'Unknown error';
  return `Pipeline failed [${code}]${location}${attempt}: ${message}`;
}

function formatInteraction(interaction: WorkspaceRunInteraction): string {
  const title = interaction.kind === 'question'
    ? 'Pipeline question'
    : interaction.kind === 'promotion'
      ? 'Pipeline promotion'
      : 'Pipeline approval';
  const recommendation = interaction.kind === 'question' && interaction.recommendation
    ? `\n\nRecommended answer\n\n${interaction.recommendation}`
    : '';
  return `\n## ${title}\n\n${interaction.content}${recommendation}\n`;
}

async function askForAnswer(terminal: CliTerminal): Promise<string> {
  while (true) {
    const answer = await terminal.ask('Answer [/done to finish]:');
    if (answer) {
      return answer;
    }
    terminal.writeError('An answer is required to resume this pipeline question.');
  }
}

function stringifyArtifact(artifact: WorkspaceArtifact | undefined): string {
  if (!artifact || artifact.value === undefined || artifact.value === null) {
    return '';
  }
  if (typeof artifact.value === 'string') {
    return artifact.value;
  }
  return JSON.stringify(artifact.value, null, 2);
}
