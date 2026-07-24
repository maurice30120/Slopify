import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function prepareVibeHome(repoDir: string, hostEnv = join(homedir(), '.vibe', '.env')): string {
  const vibeHome = join(repoDir, '.sandcastle', 'vibe-home');
  mkdirSync(vibeHome, { recursive: true });
  const sandboxEnv = join(vibeHome, '.env');
  if (existsSync(hostEnv)) {
    copyFileSync(hostEnv, sandboxEnv);
  }
  writeVibeYoloConfig(join(vibeHome, 'config.toml'));
  return vibeHome;
}

function writeVibeYoloConfig(configPath: string): void {
  let content = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';

  content = setTomlRootValue(content, 'bypass_tool_permissions', 'true');
  content = setTomlRootValue(content, 'experimental_bash_tool', 'true');
  content = setTomlRootValue(content, 'ask_confirmation_on_exit', 'false');

  for (const tool of ['edit', 'write_file', 'bash', 'task', 'web_search']) {
    content = setTomlToolPermission(content, tool, 'always');
  }

  writeFileSync(configPath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
}

function setTomlRootValue(content: string, key: string, value: string): string {
  const line = `${key} = ${value}`;
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, 'm');
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }
  return content ? `${line}\n${content}` : `${line}\n`;
}

function setTomlToolPermission(content: string, tool: string, permission: string): string {
  const section = `[tools.${tool}]`;
  const sectionPattern = new RegExp(`(^\\[tools\\.${escapeRegExp(tool)}\\]\\n)([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm');
  const match = content.match(sectionPattern);
  if (!match) {
    return `${content.trimEnd()}\n\n${section}\npermission = "${permission}"\n`;
  }

  const body = match[2];
  const nextBody = /^permission\s*=.*$/m.test(body)
    ? body.replace(/^permission\s*=.*$/m, `permission = "${permission}"`)
    : `permission = "${permission}"\n${body}`;
  return content.replace(sectionPattern, `${match[1]}${nextBody}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
