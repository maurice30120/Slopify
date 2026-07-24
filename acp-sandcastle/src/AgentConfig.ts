import { fileURLToPath } from 'node:url';
import { loadSandcastleEnv } from './SandcastleEnv.js';

export type SandcastleProvider = 'codex' | 'cursor' | 'pi' | 'vibe';
export type SandcastleEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type SandcastlePromotion = 'ask' | 'autoApply' | 'autoReject';

export interface SandcastleAgentConfig {
  transport: 'sandcastle';
  provider: SandcastleProvider;
  model: string;
  effort?: SandcastleEffort;
  maxIterations?: number;
  displayName?: string;
  env?: Record<string, string>;
  skills?: boolean;
}

export interface SandcastleBridgeProcessConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function buildSandcastleBridgeProcessConfig(
  config: SandcastleAgentConfig,
  workspaceCwd = process.cwd(),
): SandcastleBridgeProcessConfig {
  const bridgePath = fileURLToPath(new URL('./bridge.js', import.meta.url));
  const args = [bridgePath, '--provider', config.provider, '--model', config.model];
  if (config.effort) {
    args.push('--effort', config.effort);
  }
  if (config.maxIterations) {
    args.push('--max-iterations', String(config.maxIterations));
  }

  const fileEnv = loadSandcastleEnv(workspaceCwd);
  const env = {
    ...fileEnv,
    ...(config.env ?? {}),
    ACP_SANDCASTLE_IMAGE: config.env?.ACP_SANDCASTLE_IMAGE
      ?? fileEnv.ACP_SANDCASTLE_IMAGE
      ?? process.env.ACP_SANDCASTLE_IMAGE
      ?? 'acp-client-sandcastle:local',
  };
  return { command: process.execPath, args, env };
}
