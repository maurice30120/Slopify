import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  NativeAcpAgentConfig,
  AcpRuntimeConfig,
  AgentCatalog,
  AgentConfigEntry,
  SandcastleAgentConfig,
  SandcastleConfig,
  SandcastleEffort,
  SandcastlePromotion,
  SandcastleProvider,
} from '../types.js';

const CONFIG_PATH = '.acp/acp-agents.json';
const SANDCASTLE_CONFIG_PATH = '.acp/.sandcastle/config.json';
const DEFAULT_INSTRUCTIONS_MAX_BYTES = 256 * 1024;
const SANDCASTLE_PROVIDERS = new Set<string>(['codex', 'cursor', 'pi', 'vibe']);
const SANDCASTLE_EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh']);
const SANDCASTLE_PROMOTIONS = new Set<string>(['ask', 'autoApply', 'autoReject']);
const MIN_SANDCASTLE_MAX_ITERATIONS = 1;
const MAX_SANDCASTLE_MAX_ITERATIONS = 20;
const TIMEOUT_KEYS = [
  'initializeMs',
  'newSessionMs',
  'authenticateMs',
  'promptMs',
  'permissionMs',
  'authUiMs',
  'promotionUiMs',
] as const;

export function loadAcpConfig(workspaceCwd: string, configRoot = workspaceCwd): AcpRuntimeConfig {
  const filePath = path.join(configRoot, CONFIG_PATH);
  if (!fs.existsSync(filePath)) {
    return {
      filePath,
      agents: {},
      pipeline: {
        enabled: true,
        instructionsMaxBytes: DEFAULT_INSTRUCTIONS_MAX_BYTES,
      },
      errors: [`Missing ACP config at workspace root: ${CONFIG_PATH}`],
    };
  }

  try {
    return parseAcpConfig(fs.readFileSync(filePath, 'utf8'), filePath);
  } catch (e: unknown) {
    return {
      filePath,
      agents: {},
      pipeline: {
        enabled: true,
        instructionsMaxBytes: DEFAULT_INSTRUCTIONS_MAX_BYTES,
      },
      errors: [`Failed to read ACP config: ${formatError(e)}`],
    };
  }
}

export function parseAcpConfig(text: string, filePath = CONFIG_PATH): AcpRuntimeConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e: unknown) {
    return emptyConfig(filePath, [`JSON parse error: ${formatError(e)}`]);
  }

  if (!isRecord(parsed)) {
    return emptyConfig(filePath, ['ACP config must be an object.']);
  }

  const errors: string[] = [];
  const agents: Record<string, NativeAcpAgentConfig> = {};
  const agentsValue = parsed.agents;

  if (!isRecord(agentsValue)) {
    errors.push('agents must be an object.');
  } else {
    for (const [name, value] of Object.entries(agentsValue)) {
      const agent = parseAgent(name, value, errors);
      if (agent) {
        agents[name] = agent;
      }
    }
  }

  const pipeline = parsePipelineConfig(parsed.pipeline, errors);

  return {
    filePath,
    agents,
    pipeline,
    errors,
  };
}

export function loadSandcastleConfig(workspaceCwd: string, configRoot = workspaceCwd): SandcastleConfig {
  const filePath = path.join(configRoot, SANDCASTLE_CONFIG_PATH);
  if (!fs.existsSync(filePath)) {
    return emptySandcastleConfig(filePath, []);
  }

  try {
    return parseSandcastleConfig(fs.readFileSync(filePath, 'utf8'), filePath);
  } catch (e: unknown) {
    return emptySandcastleConfig(filePath, [`Failed to read Sandcastle config: ${formatError(e)}`]);
  }
}

export function parseSandcastleConfig(text: string, filePath = SANDCASTLE_CONFIG_PATH): SandcastleConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e: unknown) {
    return emptySandcastleConfig(filePath, [`JSON parse error: ${formatError(e)}`]);
  }

  if (!isRecord(parsed)) {
    return emptySandcastleConfig(filePath, ['Sandcastle config must be an object.']);
  }

  const errors: string[] = [];
  const promotion = readSandcastlePromotion(parsed.promotion, errors);
  const agents: Record<string, SandcastleAgentConfig> = {};
  const agentsValue = parsed.agents;

  if (!isRecord(agentsValue)) {
    errors.push('agents must be an object.');
  } else {
    for (const [name, value] of Object.entries(agentsValue)) {
      const agent = parseSandcastleAgent(name, value, errors);
      if (agent) {
        agents[name] = agent;
      }
    }
  }

  return {
    filePath,
    promotion,
    agents,
    errors,
  };
}

export function loadAgentCatalog(workspaceCwd: string, configRoot = workspaceCwd): AgentCatalog {
  const native = loadAcpConfig(workspaceCwd, configRoot);
  const sandcastle = loadSandcastleConfig(workspaceCwd, configRoot);
  const agents: Record<string, AgentConfigEntry> = { ...native.agents };
  const errors = [...native.errors, ...sandcastle.errors];

  for (const [name, config] of Object.entries(sandcastle.agents)) {
    if (native.agents[name]) {
      errors.push(`Agent "${name}" is declared in both ${CONFIG_PATH} and ${SANDCASTLE_CONFIG_PATH}; remove the duplicate before referencing it from a pipeline.`);
      delete agents[name];
      continue;
    }
    agents[name] = config;
  }

  return {
    native,
    sandcastle,
    agents,
    errors,
  };
}

export function writeAgentConfigs(
  agents: Record<string, AgentConfigEntry>,
  workspaceCwd: string,
): void {
  const nativePath = path.join(workspaceCwd, CONFIG_PATH);
  const sandcastlePath = path.join(workspaceCwd, SANDCASTLE_CONFIG_PATH);
  const nativeAgents: Record<string, NativeAcpAgentConfig> = {};
  const sandcastleAgents: Record<string, SandcastleAgentConfig> = {};
  for (const [name, config] of Object.entries(agents)) {
    if (isSandcastleAgentConfig(config)) sandcastleAgents[name] = config;
    else nativeAgents[name] = config;
  }
  const nativeEnvelope = readJsonObject(nativePath);
  const sandcastleEnvelope = readJsonObject(sandcastlePath);
  fs.mkdirSync(path.dirname(nativePath), { recursive: true });
  fs.mkdirSync(path.dirname(sandcastlePath), { recursive: true });
  fs.writeFileSync(nativePath, JSON.stringify({ ...nativeEnvelope, agents: nativeAgents }, null, 2) + '\n');
  fs.writeFileSync(sandcastlePath, JSON.stringify({ ...sandcastleEnvelope, agents: sandcastleAgents }, null, 2) + '\n');
}

export function upsertAgentConfig(
  agentName: string,
  config: NativeAcpAgentConfig | SandcastleAgentConfig,
  workspaceCwd: string,
): void {
  const catalog = loadAgentCatalog(workspaceCwd);
  writeAgentConfigs({ ...catalog.agents, [agentName]: config }, workspaceCwd);
}

export function removeAgentConfig(
  agentName: string,
  workspaceCwd: string,
): void {
  const catalog = loadAgentCatalog(workspaceCwd);
  const agents = { ...catalog.agents };
  delete agents[agentName];
  writeAgentConfigs(agents, workspaceCwd);
}

function readJsonObject(filePath: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isRecord(value) ? value : {};
  } catch { return {}; }
}

function emptyConfig(filePath: string, errors: string[]): AcpRuntimeConfig {
  return {
    filePath,
    agents: {},
    pipeline: {
      enabled: true,
      instructionsMaxBytes: DEFAULT_INSTRUCTIONS_MAX_BYTES,
    },
    errors,
  };
}

function emptySandcastleConfig(filePath: string, errors: string[]): SandcastleConfig {
  return {
    filePath,
    promotion: 'autoApply',
    agents: {},
    errors,
  };
}

function parseAgent(
  name: string,
  value: unknown,
  errors: string[],
): NativeAcpAgentConfig | null {
  if (!isRecord(value)) {
    errors.push(`agents.${name} must be an object.`);
    return null;
  }

  if (value.transport === 'sandcastle') {
    errors.push(`agents.${name}.transport must not be "sandcastle" in ${CONFIG_PATH}; declare Sandcastle agents in ${SANDCASTLE_CONFIG_PATH}.`);
    return null;
  }

  if (value.transport !== undefined && value.transport !== 'acp') {
    errors.push(`agents.${name}.transport must be "acp" when provided.`);
    return null;
  }

  if (typeof value.command !== 'string' || value.command.trim().length === 0) {
    errors.push(`agents.${name}.command must be a non-empty string.`);
    return null;
  }

  const args = value.args === undefined ? undefined : readStringArray(value.args, `agents.${name}.args`, errors);
  const env = value.env === undefined ? undefined : readStringRecord(value.env, `agents.${name}.env`, errors);
  if (args === null || env === null) {
    return null;
  }

  return {
    command: value.command.trim(),
    ...(value.transport === 'acp' ? { transport: 'acp' as const } : {}),
    ...(args === undefined ? {} : { args }),
    ...(env === undefined ? {} : { env }),
    ...(typeof value.loginShell === 'boolean' ? { loginShell: value.loginShell } : {}),
    ...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}),
    ...(typeof value.use_idea_mcp === 'boolean' ? { use_idea_mcp: value.use_idea_mcp } : {}),
    ...(typeof value.use_custom_mcp === 'boolean' ? { use_custom_mcp: value.use_custom_mcp } : {}),
    ...(typeof value.skills === 'boolean' ? { skills: value.skills } : {}),
  };
}

function parseSandcastleAgent(
  name: string,
  value: unknown,
  errors: string[],
): SandcastleAgentConfig | null {
  if (!isRecord(value)) {
    errors.push(`agents.${name} must be an object.`);
    return null;
  }

  if (value.transport !== 'sandcastle') {
    errors.push(`agents.${name}.transport must be "sandcastle".`);
    return null;
  }

  const provider = readSandcastleProvider(value.provider, `agents.${name}.provider`, errors);
  const model = readNonEmptyString(value.model, `agents.${name}.model`, errors);
  const effort = value.effort === undefined
    ? undefined
    : readSandcastleEffort(value.effort, `agents.${name}.effort`, errors);
  const env = value.env === undefined ? undefined : readStringRecord(value.env, `agents.${name}.env`, errors);
  const maxIterations = value.maxIterations === undefined
    ? undefined
    : readSandcastleMaxIterations(value.maxIterations, `agents.${name}.maxIterations`, errors);

  if (!provider || !model || effort === null || env === null || maxIterations === null) {
    return null;
  }

  return {
    transport: 'sandcastle',
    provider,
    model,
    ...(effort === undefined ? {} : { effort }),
    ...(maxIterations === undefined ? {} : { maxIterations }),
    ...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}),
    ...(env === undefined ? {} : { env }),
    ...(typeof value.skills === 'boolean' ? { skills: value.skills } : {}),
  };
}

function readSandcastlePromotion(value: unknown, errors: string[]): SandcastlePromotion {
  if (typeof value === 'string' && SANDCASTLE_PROMOTIONS.has(value)) {
    return value as SandcastlePromotion;
  }
  errors.push('promotion must be "ask", "autoApply", or "autoReject".');
  return 'ask';
}

function readSandcastleProvider(
  value: unknown,
  scope: string,
  errors: string[],
): SandcastleProvider | null {
  if (typeof value === 'string' && SANDCASTLE_PROVIDERS.has(value)) {
    return value as SandcastleProvider;
  }
  errors.push(`${scope} must be "codex", "cursor", "pi", or "vibe".`);
  return null;
}

function readSandcastleEffort(
  value: unknown,
  scope: string,
  errors: string[],
): SandcastleEffort | null {
  if (typeof value === 'string' && SANDCASTLE_EFFORTS.has(value)) {
    return value as SandcastleEffort;
  }
  errors.push(`${scope} must be "low", "medium", "high", or "xhigh".`);
  return null;
}

function readSandcastleMaxIterations(
  value: unknown,
  scope: string,
  errors: string[],
): number | null {
  if (
    typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_SANDCASTLE_MAX_ITERATIONS
    && value <= MAX_SANDCASTLE_MAX_ITERATIONS
  ) {
    return value;
  }
  errors.push(`${scope} must be an integer between ${MIN_SANDCASTLE_MAX_ITERATIONS} and ${MAX_SANDCASTLE_MAX_ITERATIONS}.`);
  return null;
}

function readNonEmptyString(value: unknown, scope: string, errors: string[]): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${scope} must be a non-empty string.`);
    return null;
  }
  return value.trim();
}

function parsePipelineConfig(value: unknown, errors: string[]) {
  if (value === undefined) {
    return {
      enabled: true,
      instructionsMaxBytes: DEFAULT_INSTRUCTIONS_MAX_BYTES,
    };
  }

  if (!isRecord(value)) {
    errors.push('pipeline must be an object when provided.');
    return {
      enabled: true,
      instructionsMaxBytes: DEFAULT_INSTRUCTIONS_MAX_BYTES,
    };
  }

  const enabled = value.enabled === undefined
    ? true
    : typeof value.enabled === 'boolean'
      ? value.enabled
      : (() => {
          errors.push('pipeline.enabled must be a boolean.');
          return true;
        })();

  const instructionsMaxBytes = value.instructionsMaxBytes === undefined
    ? DEFAULT_INSTRUCTIONS_MAX_BYTES
    : typeof value.instructionsMaxBytes === 'number'
      && Number.isInteger(value.instructionsMaxBytes)
      && value.instructionsMaxBytes > 0
        ? value.instructionsMaxBytes
        : (() => {
            errors.push('pipeline.instructionsMaxBytes must be a positive integer.');
            return DEFAULT_INSTRUCTIONS_MAX_BYTES;
          })();

  const timeouts = parseTimeoutConfig(value.timeouts, errors);

  return { enabled, instructionsMaxBytes, ...(timeouts ? { timeouts } : {}) };
}

function parseTimeoutConfig(value: unknown, errors: string[]) {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    errors.push('pipeline.timeouts must be an object when provided.');
    return undefined;
  }

  const result: Record<string, number> = {};
  for (const key of TIMEOUT_KEYS) {
    const timeoutValue = value[key];
    if (timeoutValue === undefined) {
      continue;
    }
    if (
      typeof timeoutValue !== 'number'
      || !Number.isInteger(timeoutValue)
      || timeoutValue <= 0
    ) {
      errors.push(`pipeline.timeouts.${key} must be a positive integer.`);
      continue;
    }
    result[key] = timeoutValue;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function readStringArray(value: unknown, scope: string, errors: string[]): string[] | null {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    errors.push(`${scope} must be an array of strings.`);
    return null;
  }
  return value;
}

function readStringRecord(value: unknown, scope: string, errors: string[]): Record<string, string> | null {
  if (!isRecord(value)) {
    errors.push(`${scope} must be an object of string values.`);
    return null;
  }
  const result: Record<string, string> = {};
  for (const [key, recordValue] of Object.entries(value)) {
    if (typeof recordValue !== 'string') {
      errors.push(`${scope}.${key} must be a string.`);
      return null;
    }
    result[key] = recordValue;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function formatNativeConfig(config: AcpRuntimeConfig): object {
  const { filePath, errors, ...rest } = config;
  return rest;
}

function formatSandcastleConfig(config: SandcastleConfig): object {
  const { filePath, errors, ...rest } = config;
  return rest;
}

function isSandcastleAgentConfig(config: AgentConfigEntry): config is SandcastleAgentConfig {
  return (config as SandcastleAgentConfig).transport === 'sandcastle';
}
