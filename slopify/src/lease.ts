import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

function leasePath(cwd: string) { return join(cwd, '.acp', 'cli-owner.json'); }

export function cliIsBusy(cwd: string): boolean {
  if (!existsSync(leasePath(cwd))) return false;
  try {
    const owner = JSON.parse(readFileSync(leasePath(cwd), 'utf8'));
    if (owner.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) return true;
    try { process.kill(owner.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  } catch { return true; }
}

/** One mutating CLI per workspace; pipeline nodes still execute concurrently. */
export function acquireCliLease(cwd: string): () => void {
  mkdirSync(join(cwd, '.acp'), { recursive: true });
  const file = leasePath(cwd);
  if (existsSync(file)) {
    const identity = statSync(file);
    if (cliIsBusy(cwd)) throw new Error('A CLI already owns this workspace. Use its terminal to finish or cancel before supervising from another process.');
    // Only reclaim a dead local owner, never an unknown or remote process.
    const current = statSync(file);
    if (current.ino !== identity.ino || current.mtimeMs !== identity.mtimeMs) throw new Error('CLI ownership changed; retry the command.');
    unlinkSync(file);
  }
  const token = randomUUID();
  const fd = openSync(file, 'wx');
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), token })); }
  finally { closeSync(fd); }
  return () => {
    try { if (JSON.parse(readFileSync(file, 'utf8')).token === token) unlinkSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
}
