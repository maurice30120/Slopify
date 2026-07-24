import type { CompiledPipelineProgram } from '@acp-client/pipeline';
import { getPipelinePrograms } from './pipelineCatalog.js';
import { loadAgentCatalog } from '../config/config.js';
import type { AgentConfigEntry } from '../types.js';

export type AgentResolution =
  | { kind: 'configured'; name: string; runnable: true; errors: [] }
  | { kind: 'pipeline'; name: string; runnable: true; pipeline: CompiledPipelineProgram; errors: [] };

export function resolveWorkspaceAgent(
  agentName: string,
  workspaceCwd: string,
  agentConfigs: Record<string, AgentConfigEntry> = loadAgentCatalog(workspaceCwd).agents,
): AgentResolution | null {
  const normalized = agentName.replace(/ \(invalid\)$/, '');
  if (agentConfigs[normalized]) {
    return { kind: 'configured', name: normalized, runnable: true, errors: [] };
  }
  const pipeline = getPipelinePrograms(workspaceCwd).find(program => program.id === normalized || program.title === normalized);
  return pipeline
    ? { kind: 'pipeline', name: pipeline.title, runnable: true, pipeline, errors: [] }
    : null;
}

export function listWorkspaceAgentNames(
  workspaceCwd: string,
  agentConfigs: Record<string, AgentConfigEntry> = loadAgentCatalog(workspaceCwd).agents,
): string[] {
  const configured = Object.keys(agentConfigs);
  const names = new Set(configured);
  for (const program of getPipelinePrograms(workspaceCwd)) names.add(program.title);
  return [...names];
}
