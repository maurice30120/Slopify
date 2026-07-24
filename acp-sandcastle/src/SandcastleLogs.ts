import * as fs from 'node:fs';
import * as path from 'node:path';

const SANDCASTLE_LOG_DIRS = [
  path.join('.sandcastle', 'logs'),
  path.join('.sandcastle', 'vibe-home', 'logs', 'session'),
];

export function clearSandcastleLogs(workspaceCwd: string): void {
  for (const relativeDir of SANDCASTLE_LOG_DIRS) {
    const target = path.join(workspaceCwd, relativeDir);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
  }
}
