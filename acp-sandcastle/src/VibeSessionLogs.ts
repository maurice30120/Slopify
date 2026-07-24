import * as fs from 'node:fs';
import * as path from 'node:path';

export type VibeSessionFallback = {
  text: string;
  sessionId?: string;
  logPath?: string;
};

export type VibeSessionFallbackOptions = {
  requireCompleted?: boolean;
};

type VibeSessionCandidate = {
  dir: string;
  messagesPath: string;
  metaPath: string;
  startedAtMs: number;
  mtimeMs: number;
};

const SESSION_START_GRACE_MS = 5_000;

export function readVibeSessionFallback(
  repoDir: string,
  runStartedAt: string,
  options: VibeSessionFallbackOptions = {},
): VibeSessionFallback | undefined {
  const session = findLatestVibeSession(repoDir, runStartedAt, options);
  if (!session) {
    return undefined;
  }

  const meta = readJsonObject(session.metaPath);
  const assistantText = readLastAssistantText(session.messagesPath);
  const sessionId = typeof meta?.session_id === 'string' ? meta.session_id : undefined;
  if (assistantText) {
    return {
      text: assistantText,
      sessionId,
      logPath: session.messagesPath,
    };
  }

  const stats = meta && typeof meta.stats === 'object' ? meta.stats as Record<string, unknown> : {};
  const steps = typeof stats.steps === 'number' ? stats.steps : undefined;
  const succeeded = typeof stats.tool_calls_succeeded === 'number' ? stats.tool_calls_succeeded : undefined;
  const rejected = typeof stats.tool_calls_rejected === 'number' ? stats.tool_calls_rejected : undefined;
  const summary = [
    sessionId ? `Vibe session ${sessionId.slice(0, 8)} finished` : 'Vibe session finished',
    steps !== undefined ? `${steps} steps` : undefined,
    succeeded !== undefined ? `${succeeded} tool calls succeeded` : undefined,
    rejected !== undefined ? `${rejected} rejected` : undefined,
  ].filter(Boolean).join(', ');

  return {
    text: `${summary || 'Vibe session finished'} but did not emit assistant output. Logs: ${session.messagesPath}`,
    sessionId,
    logPath: session.messagesPath,
  };
}

function findLatestVibeSession(
  repoDir: string,
  runStartedAt: string,
  options: VibeSessionFallbackOptions,
): VibeSessionCandidate | undefined {
  const sessionsDir = path.join(repoDir, '.sandcastle', 'vibe-home', 'logs', 'session');
  if (!fs.existsSync(sessionsDir)) {
    return undefined;
  }

  const minStartMs = Date.parse(runStartedAt) - SESSION_START_GRACE_MS;
  const candidates = fs.readdirSync(sessionsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => toCandidate(path.join(sessionsDir, entry.name)))
    .filter((candidate): candidate is VibeSessionCandidate => Boolean(candidate))
    .filter(candidate => !Number.isFinite(minStartMs) || candidate.startedAtMs >= minStartMs)
    .filter(candidate => !options.requireCompleted || Boolean(readJsonObject(candidate.metaPath)?.end_time))
    .sort((a, b) => b.startedAtMs - a.startedAtMs || b.mtimeMs - a.mtimeMs);

  return candidates[0];
}

function toCandidate(dir: string): VibeSessionCandidate | undefined {
  const messagesPath = path.join(dir, 'messages.jsonl');
  const metaPath = path.join(dir, 'meta.json');
  if (!fs.existsSync(messagesPath)) {
    return undefined;
  }

  const meta = readJsonObject(metaPath);
  const startedAt = typeof meta?.start_time === 'string' ? Date.parse(meta.start_time) : Number.NaN;
  const stat = fs.statSync(messagesPath);
  return {
    dir,
    messagesPath,
    metaPath,
    startedAtMs: Number.isFinite(startedAt) ? startedAt : stat.mtimeMs,
    mtimeMs: stat.mtimeMs,
  };
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  try {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function readLastAssistantText(messagesPath: string): string | undefined {
  try {
    const lines = fs.readFileSync(messagesPath, 'utf8').split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) {
        continue;
      }
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.role !== 'assistant') {
        continue;
      }
      const text = extractTextContent(message.content).trim();
      if (text) {
        return text;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map(part => part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n');
}
