import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { SandcastleProviderName } from './BridgeConfig.js';

const NOISE_STDERR = /^reading prompt from stdin\.\.\.?$/i;
const EXIT_PREFIX = /^(\w[\w-]*) exited with code \d+:\n?([\s\S]*)$/i;
const GO_USAGE_LIMIT = /\b429\b[\s\S]*\bGoUsageLimitError\b|\bGoUsageLimitError\b[\s\S]*\b429\b/i;
const OPENCODE_MODEL = /\bopencode-go\/[A-Za-z0-9._-]+\b/i;

export function parseCodexJsonStreamErrors(text: string): string | undefined {
  let lastError: string | undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj.type === 'error' && typeof obj.message === 'string' && obj.message.trim()) {
        lastError = obj.message.trim();
      }
      if (obj.type === 'turn.failed') {
        const error = obj.error as { message?: string } | undefined;
        if (typeof error?.message === 'string' && error.message.trim()) {
          lastError = error.message.trim();
        }
      }
      if (obj.type === 'item.completed') {
        const item = obj.item as { type?: string; message?: string } | undefined;
        if (item?.type === 'error' && typeof item.message === 'string' && item.message.trim()) {
          lastError = item.message.trim();
        }
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }
  return lastError;
}

export function readLatestCodexRolloutError(repoDir: string): string | undefined {
  const sessionsRoot = join(repoDir, '.sandcastle', 'codex-home', 'sessions');
  const rolloutPath = findNewestFile(sessionsRoot, '.jsonl');
  if (!rolloutPath) {
    return undefined;
  }
  return extractCodexRolloutError(readFileSync(rolloutPath, 'utf8'));
}

export function extractCodexRolloutError(content: string): string | undefined {
  const lines = content.trim().split('\n').filter(Boolean);
  let sawZeroCredits = false;

  for (const line of lines) {
    const streamError = parseCodexJsonStreamErrors(line);
    if (streamError) {
      return streamError;
    }

    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.type === 'event_msg') {
        const payload = obj.payload as Record<string, unknown> | undefined;
        if (payload?.type === 'token_count') {
          const rateLimits = payload.rate_limits as { credits?: { has_credits?: boolean; balance?: string | number } } | undefined;
          const credits = rateLimits?.credits;
          if (credits?.has_credits === false && (credits.balance === 0 || credits.balance === '0')) {
            sawZeroCredits = true;
          }
        }
        if (
          payload?.type === 'task_complete'
          && (payload.last_agent_message === null || payload.last_agent_message === undefined)
          && sawZeroCredits
        ) {
          return 'Codex usage limit reached: no credits remaining on your account. Visit https://chatgpt.com/codex/settings/usage or try again later.';
        }
      }
    } catch {
      // Ignore malformed rollout lines.
    }
  }

  return undefined;
}

function simplifySandcastleExitMessage(message: string): string | undefined {
  const match = message.match(EXIT_PREFIX);
  if (!match) {
    return parseUsageLimitMessage(message) || parseCodexJsonStreamErrors(message) || message.trim() || undefined;
  }

  const body = match[2].trim();
  if (!body || NOISE_STDERR.test(body)) {
    return undefined;
  }

  const usageLimit = parseUsageLimitMessage(body);
  if (usageLimit) {
    return usageLimit;
  }

  const fromJson = parseCodexJsonStreamErrors(body);
  if (fromJson) {
    return fromJson;
  }

  const withoutNoise = body
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !NOISE_STDERR.test(line))
    .join('\n')
    .trim();
  return withoutNoise || undefined;
}

function parseUsageLimitMessage(text: string): string | undefined {
  if (!GO_USAGE_LIMIT.test(text)) {
    return undefined;
  }

  const model = text.match(OPENCODE_MODEL)?.[0];
  const target = model ? ` for ${model}` : '';
  return `Pi Sandcastle failed before writing: provider returned 429 GoUsageLimitError${target}, so no write tool was executed.`;
}

export function enrichProviderRunError(
  error: unknown,
  options: { provider: SandcastleProviderName; cwd: string },
): Error {
  const base = error instanceof Error ? error.message : String(error);
  const fromDetails = simplifySandcastleExitMessage(base);
  const fromRollout = options.provider === 'codex'
    ? readLatestCodexRolloutError(options.cwd)
    : undefined;
  const message = fromRollout || fromDetails;

  if (!message) {
    return error instanceof Error ? error : new Error(base || 'Sandcastle agent run failed.');
  }
  if (error instanceof Error && error.message === message) {
    return error;
  }
  return new Error(message);
}

function findNewestFile(root: string, extension: string): string | undefined {
  if (!existsSync(root)) {
    return undefined;
  }

  let newest: { path: string; mtime: number } | undefined;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(extension)) {
        continue;
      }
      const mtime = statSync(fullPath).mtimeMs;
      if (!newest || mtime > newest.mtime) {
        newest = { path: fullPath, mtime };
      }
    }
  }
  return newest?.path;
}
