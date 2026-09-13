import { workspacePipelineRunStore, type PipelineRuntimeSnapshot } from '@acp-client/pipeline';
import { cliIsBusy } from './lease.js';

export function availableActions(snapshot: PipelineRuntimeSnapshot) {
  const actions: Array<{ kind: 'resume' | 'cancel' | 'retry'; nodeId?: string; pauseId?: string; precondition: string }> = [];
  if (snapshot.status === 'running' || snapshot.status === 'paused') {
    actions.push({ kind: 'resume', precondition: 'No other CLI process owns this run; recover the persisted state.' });
    actions.push({ kind: 'cancel', precondition: 'No other CLI process owns this run; cancel its persisted state.' });
  }
  const pause = snapshot.pendingPause;
  if (snapshot.status === 'paused' && pause && snapshot.nodeStates[pause.nodeId]?.status === 'completed') {
    actions.push({ kind: 'retry', nodeId: pause.nodeId, pauseId: pause.id, precondition: 'The current pause belongs to this completed agent node.' });
  }
  return actions;
}

export async function inspectRun(cwd: string, runId: string) {
  const snapshot = await workspacePipelineRunStore(cwd).load(runId);
  if (!snapshot) throw new Error(`Unknown run: ${runId}`);
  const busy = cliIsBusy(cwd);
  return { contract: 'slopify.run-inspection/v1', snapshot, ownerActive: busy, actions: busy ? [] : availableActions(snapshot) };
}

export async function readRunLogs(cwd: string, runId: string) {
  const store = workspacePipelineRunStore(cwd);
  if (!await store.load(runId)) throw new Error(`Unknown run: ${runId}`);
  return { contract: 'slopify.run-events/v1', runId, events: await store.readEvents(runId) };
}

export function formatInspection(value: Awaited<ReturnType<typeof inspectRun>>): string {
  const { snapshot } = value;
  return [`${snapshot.runId} — ${snapshot.pipelineId} — ${snapshot.status}`,
    ...Object.entries(snapshot.nodeStates).map(([nodeId, state]) => {
      const progress = snapshot.progress?.[nodeId];
      const activity = progress?.attempt === state.attempts ? progress.activity : undefined;
      return `${nodeId}  ${state.status}${activity ? ` — ${[activity.action, activity.target, activity.result, activity.observation].filter(Boolean).join(' · ')} (${progress!.at})` : ''}`;
    }),
    ...snapshot.diagnostics.map(error => `${error.code}: ${error.message}`),
    ...(snapshot.pendingPause ? [`En attente : ${snapshot.pendingPause.content}`] : []),
    `Actions : ${value.actions.map(action => action.kind).join(', ') || 'aucune'}`,
  ].join('\n');
}
