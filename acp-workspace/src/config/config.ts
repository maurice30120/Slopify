import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  NativeAcpAgentConfig,
  AcpRuntimeConfig,
  AgentCatalog,
  AgentConfigEntry,
  SandboxAgentConfig,
} from '../types.js';

const CONFIG_PATH = '.acp/acp-agents.json';
const LEGACY_CONFIG_PATH = '.acp/.sandcastle/config.json';
const DEFAULT_INSTRUCTIONS_MAX_BYTES = 256 * 1024;
const SANDBOX_EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh']);
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
  const agents: Record<string, NativeAcpAgentConfig | SandboxAgentConfig> = {};
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

export function loadAgentCatalog(workspaceCwd: string, configRoot = workspaceCwd): AgentCatalog {
  const config = loadAcpConfig(workspaceCwd, configRoot);
  const legacyPath = path.join(configRoot, LEGACY_CONFIG_PATH);
  const errors = [...config.errors];
  if (fs.existsSync(legacyPath)) errors.push(legacyConfigMigrationError());

  return {
    config,
    agents: { ...config.agents },
    errors,
  };
}

export function writeAgentConfigs(
  agents: Record<string, AgentConfigEntry>,
  workspaceCwd: string,
): void {
  const filePath = path.join(workspaceCwd, CONFIG_PATH);
  const envelope = readJsonObject(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ ...envelope, agents }, null, 2) + '\n');
}

export function upsertAgentConfig(
  agentName: string,
  config: NativeAcpAgentConfig | SandboxAgentConfig,
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

function parseAgent(
  name: string,
  value: unknown,
  errors: string[],
): NativeAcpAgentConfig | SandboxAgentConfig | null {
  if (!isRecord(value)) {
    errors.push(`agents.${name} must be an object.`);
    return null;
  }

  if (value.transport === 'sandbox') {
    if (value.agent !== 'codex') {
      errors.push(`agents.${name}.agent must be "codex" for transport "sandbox"; other Docker Sandbox agents are not supported yet.`);
      return null;
    }
    const model = readNonEmptyString(value.model, `agents.${name}.model`, errors);
    const effort = value.effort === undefined
      ? undefined
      : readSandboxEffort(value.effort, `agents.${name}.effort`, errors);
    if (!model || effort === null) return null;
    return {
      transport: 'sandbox',
      agent: 'codex',
      model,
      ...(effort === undefined ? {} : { effort }),
      ...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}),
      ...(typeof value.skills === 'boolean' ? { skills: value.skills } : {}),
    };
  }

  if (value.transport === 'sandcastle') {
    errors.push(`agents.${name}.transport "sandcastle" is no longer supported. Migrate manually to { "transport": "sandbox", "agent": "codex", "model": "..." } in ${CONFIG_PATH}.`);
    return null;
  }

  if (value.transport !== undefined && value.transport !== 'acp') {
    errors.push(`agents.${name}.transport must be "acp" or "sandbox" when provided.`);
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

function readSandboxEffort(
  value: unknown,
  scope: string,
  errors: string[],
): SandboxAgentConfig['effort'] | null {
  if (typeof value === 'string' && SANDBOX_EFFORTS.has(value)) {
    return value as SandboxAgentConfig['effort'];
  }
  errors.push(`${scope} must be "low", "medium", "high", or "xhigh".`);
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

function legacyConfigMigrationError(): string {
  return `${LEGACY_CONFIG_PATH} is no longer supported because the historical runtime and its providers were removed. Migrate manually in ${CONFIG_PATH} with an agent using transport: "sandbox", agent: "codex", and a model, then remove ${LEGACY_CONFIG_PATH}. No legacy configuration was parsed or applied.`;
}
