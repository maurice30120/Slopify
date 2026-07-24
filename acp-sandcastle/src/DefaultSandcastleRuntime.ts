import { createDockerSandboxProvider } from './SandboxMounts.js';
import { prepareCodexHome } from './SandboxMounts.js';
import {
  codex,
  createSandbox,
  cursor,
  pi,
  type AgentProvider,
} from '@ai-hero/sandcastle';

import type { BridgeConfig } from './BridgeConfig.js';
import type { SandcastleRuntime } from './BridgeAgent.js';

export { prepareCodexHome };

export const defaultSandcastleRuntime: SandcastleRuntime = {
  createSandbox,
  createProvider(config: BridgeConfig) {
    if (config.provider === 'codex') {
      return codex(config.model, {
        effort: config.effort,
        env: config.env,
        captureSessions: false,
      });
    }
    if (config.provider === 'pi') {
      return pi(config.model, {
        thinking: config.effort,
        env: config.env,
        captureSessions: false,
      });
    }
    if (config.provider === 'vibe') {
      return vibe(config.model, {
        env: config.env,
      });
    }
    return cursor(config.model);
  },
  createSandboxProvider(config: BridgeConfig, cwd: string, branch?: string) {
    return createDockerSandboxProvider(config, cwd, branch);
  },
};

interface VibeOptions {
  env?: Record<string, string>;
}

function vibe(model: string, options: VibeOptions = {}): AgentProvider {
  return {
    name: 'vibe',
    env: {
      ...(options.env ?? {}),
      VIBE_ACTIVE_MODEL: model,
      VIBE_HOME: '/home/agent/.vibe',
    },
    captureSessions: false,
    buildPrintCommand({ prompt }) {
      return {
        command: `vibe --prompt ${shellEscape(prompt)} --output streaming --trust`,
      };
    },
    buildInteractiveArgs({ prompt }) {
      const args = ['vibe'];
      if (prompt) {
        args.push(prompt);
      }
      return args;
    },
    parseStreamLine(line) {
      return parseVibeStreamLine(line);
    },
  };
}

function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function parseVibeStreamLine(line: string): ReturnType<AgentProvider['parseStreamLine']> {
  if (!line.startsWith('{')) {
    return [];
  }
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const role = obj.role;
    const content = typeof obj.content === 'string' ? obj.content : undefined;
    const reasoningContent = typeof obj.reasoning_content === 'string' ? obj.reasoning_content : undefined;
    if (role === 'assistant') {
      if (content) {
        return [
          { type: 'text', text: content },
          { type: 'result', result: content },
        ];
      }
      if (reasoningContent) {
        return [{ type: 'text', text: reasoningContent }];
      }
    }
    if (typeof obj.session_id === 'string') {
      return [{ type: 'session_id', sessionId: obj.session_id }];
    }
  } catch {
    return [];
  }
  return [];
}
