import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadSandcastleEnv(workspaceCwd: string): Record<string, string> {
  const envPath = join(workspaceCwd, '.sandcastle', '.env');
  if (!existsSync(envPath)) {
    return {};
  }
  return parseDotEnv(readFileSync(envPath, 'utf8'));
}

export function parseDotEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const assignment = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line;
    const separator = assignment.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const key = assignment.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    env[key] = parseDotEnvValue(assignment.slice(separator + 1).trim());
  }
  return env;
}

function parseDotEnvValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  const commentIndex = value.search(/\s#/);
  return (commentIndex >= 0 ? value.slice(0, commentIndex) : value).trimEnd();
}
