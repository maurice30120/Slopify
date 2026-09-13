import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompiledPipelineProgram } from '@acp-client/pipeline';

export interface PipelineDescription {
  id: string;
  intention: string;
  steps: string[];
  prerequisites: string[];
  capabilities: string[];
  results: string[];
  approximateCost: string;
}

export function readPipelineCatalog(cwd: string, programs: CompiledPipelineProgram[]) {
  const raw = readFileSync(join(cwd, '.acp', 'pipeline-catalog.json'), 'utf8');
  const value: unknown = JSON.parse(raw);
  if (!record(value) || value.contract !== 'slopify.pipeline-catalog/v1'
    || typeof value.version !== 'string' || !value.version.trim() || !Array.isArray(value.pipelines)) {
    throw new Error('Invalid pipeline catalogue: expected slopify.pipeline-catalog/v1, version and pipelines.');
  }
  const ids = new Set<string>();
  const pipelines = value.pipelines.map((entry: unknown): PipelineDescription => {
    if (!record(entry) || !nonempty(entry.id) || !nonempty(entry.intention) || !nonempty(entry.approximateCost)
      || !['steps', 'prerequisites', 'capabilities', 'results'].every(key => strings(entry[key]))) {
      throw new Error('Invalid pipeline catalogue entry.');
    }
    if (ids.has(entry.id)) throw new Error(`Duplicate catalogue pipeline: ${entry.id}`);
    ids.add(entry.id);
    if (!programs.some(program => program.id === entry.id)) throw new Error(`Catalogue pipeline is unavailable: ${entry.id}`);
    return entry as unknown as PipelineDescription;
  });
  return { contract: value.contract, version: value.version, digest: createHash('sha256').update(raw).digest('hex'), pipelines };
}

export interface LaunchBrief {
  contract: 'slopify.launch-brief/v1';
  objective: string;
  scope: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  decisions: string[];
  confirmation: { confirmed: true; at: string };
  selection: { requestedPipeline?: string; pipeline: string; criteria: string[]; catalogVersion: string; catalogDigest: string };
}

export function readLaunchBrief(file: string): LaunchBrief {
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!record(value) || value.contract !== 'slopify.launch-brief/v1' || !nonempty(value.objective)
    || !['scope', 'constraints', 'acceptanceCriteria', 'decisions'].every(key => strings(value[key], key === 'scope' || key === 'acceptanceCriteria'))
    || !record(value.confirmation) || value.confirmation.confirmed !== true
    || typeof value.confirmation.at !== 'string' || Number.isNaN(Date.parse(value.confirmation.at))
    || !record(value.selection) || !nonempty(value.selection.pipeline) || !strings(value.selection.criteria, true)
    || !nonempty(value.selection.catalogVersion) || !nonempty(value.selection.catalogDigest)
    || (value.selection.requestedPipeline !== undefined && value.selection.requestedPipeline !== value.selection.pipeline)) {
    throw new Error('Invalid or unconfirmed launch brief; an explicitly requested pipeline must be preserved.');
  }
  return value as unknown as LaunchBrief;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function strings(value: unknown, required = true): value is string[] {
  return Array.isArray(value) && (!required || value.length > 0) && value.every(nonempty);
}
