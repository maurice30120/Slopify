import type { AgentConfigEntry, SandcastleAgentConfig } from '../types.js';

export function isSandcastleConfig(config: AgentConfigEntry): config is SandcastleAgentConfig {
  return config.transport === 'sandcastle';
}
