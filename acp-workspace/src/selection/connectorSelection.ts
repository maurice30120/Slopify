import type { AgentConfigEntry, SandboxAgentConfig, SandcastleAgentConfig } from '../types.js';

export function isSandcastleConfig(config: AgentConfigEntry): config is SandcastleAgentConfig {
  return config.transport === 'sandcastle';
}

export function isSandboxConfig(config: AgentConfigEntry): config is SandboxAgentConfig {
  return config.transport === 'sandbox';
}
