export type SandcastleProviderName = 'codex' | 'cursor' | 'pi' | 'vibe';

export interface BridgeConfig {
  provider: SandcastleProviderName;
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  maxIterations: number;
  imageName: string;
  env?: Record<string, string>;
  agentId?: string;
}

export function parseBridgeConfig(argv: string[], env: NodeJS.ProcessEnv): BridgeConfig {
  const readArg = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const provider = readArg('--provider');
  if (provider !== 'codex' && provider !== 'cursor' && provider !== 'pi' && provider !== 'vibe') {
    throw new Error('Expected --provider codex|cursor|pi|vibe.');
  }

  const model = readArg('--model')?.trim();
  if (!model) {
    throw new Error('Expected a non-empty --model value.');
  }

  const effort = readArg('--effort');
  if (effort && !['low', 'medium', 'high', 'xhigh'].includes(effort)) {
    throw new Error(`Unsupported effort value: ${effort}`);
  }

  const maxIterations = readMaxIterations(readArg('--max-iterations'), provider);
  const agentId = readArg('--agent-id') || env.ACP_AGENT_ID;

  return {
    provider,
    model,
    effort: effort as BridgeConfig['effort'],
    maxIterations,
    imageName: env.ACP_SANDCASTLE_IMAGE || 'acp-client-sandcastle:local',
    env: Object.fromEntries(
      Object.entries(env).filter(([, value]) => typeof value === 'string'),
    ) as Record<string, string>,
    ...(agentId ? { agentId } : {}),
  };
}

function readMaxIterations(value: string | undefined, provider: SandcastleProviderName): number {
  if (value === undefined) {
    return provider === 'pi' || provider === 'vibe' ? 5 : 1;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error('Expected --max-iterations to be an integer between 1 and 20.');
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error('Expected --max-iterations to be an integer between 1 and 20.');
  }
  return parsed;
}
