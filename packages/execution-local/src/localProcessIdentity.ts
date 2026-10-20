import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Durable identity of the original local process, not just its reusable PID. */
export interface LocalProcessIdentity {
  pid: number;
  startedAtIso: string;
  command: string;
  /** Legacy Linux V2 snapshots may contain this value. */
  startTimeTicks?: number;
  /** OS-reported process creation time. Available on macOS and Linux via ps. */
  startTimeTag?: string;
  /** Exact command line observed when the identity was first captured. */
  observedCommand?: string;
  /** Assigned process group of the attempt; used by supervision. */
  processGroupId?: number;
}

export type LocalProcessLiveness = 'alive' | 'dead' | 'unknown';

/** ps -o lstart uses a 24-character timestamp on BSD/macOS and procps/Linux. */
async function observeProcess(pid: number): Promise<{ startTimeTag: string; command: string } | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const result = await execFileAsync('ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8', timeout: 2000 });
    const line = result.stdout.trim().split(/\r?\n/u)[0] ?? '';
    if (line.length < 26) return undefined;
    const startTimeTag = line.slice(0, 24).trim();
    const command = line.slice(24).trim();
    if (!/^[A-Za-z]{3} [A-Za-z]{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u.test(startTimeTag) || !command) return undefined;
    return { startTimeTag, command };
  } catch {
    return undefined;
  }
}

/** Capture the kernel-observed process identity for later crash recovery. */
export async function readLocalProcessIdentity(pid: number, command: string, startedAtIso = new Date().toISOString()): Promise<LocalProcessIdentity> {
  const observed = await observeProcess(pid);
  return {
    pid, command, startedAtIso,
    ...(observed ? { startTimeTag: observed.startTimeTag, observedCommand: observed.command } : {}),
  };
}

/** A missing or unreadable identity is UNKNOWN, never proof that the agent stopped. */
export async function inspectLocalProcess(identity: LocalProcessIdentity | undefined): Promise<LocalProcessLiveness> {
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0) return 'unknown';
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'dead';
    return 'unknown';
  }
  const observed = await observeProcess(identity.pid);
  if (!observed || !identity.startTimeTag || !identity.observedCommand) return 'unknown';
  if (observed.startTimeTag !== identity.startTimeTag) return 'dead';
  // A PID reused within one timestamp second must not be mistaken for our agent.
  if (observed.command !== identity.observedCommand) return 'unknown';
  return 'alive';
}

/** Conservative compatibility helper: an unverified process must also block a retry. */
export async function isLocalProcessAlive(identity: LocalProcessIdentity | undefined): Promise<boolean> {
  return (await inspectLocalProcess(identity)) !== 'dead';
}

/** Observe all members of an isolated POSIX process group, including orphan descendants. */
export async function inspectLocalProcessGroup(groupId: number): Promise<LocalProcessLiveness> {
  if (process.platform === 'win32' || !Number.isSafeInteger(groupId) || groupId <= 1) return 'unknown';
  try {
    const result = await execFileAsync('ps', ['-A', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat='], { encoding: 'utf8', timeout: 2000 });
    let zombie = false;
    for (const line of result.stdout.split(/\r?\n/u)) {
      const values = line.trim().split(/\s+/u);
      if (values.length < 3 || Number(values[1]) !== groupId) continue;
      if (values[2]?.startsWith('Z')) zombie = true;
      else return 'alive';
    }
    // Zombies cannot be killed by Slopify: a surviving zombie is a leak, not success.
    return zombie ? 'unknown' : 'dead';
  } catch {
    return 'unknown';
  }
}
