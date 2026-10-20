#!/usr/bin/env node
/**
 * Run deterministic package tests in a private POSIX process group.
 * Unlike a PPID-only check, this also detects processes orphaned to PID 1.
 * No Docker or real model provider is needed.
 */
import { spawn, spawnSync } from 'node:child_process';

const isPosix = process.platform !== 'win32';
const files = process.argv.slice(2);
const args = ['--test', '--test-concurrency=2', ...(files.length ? files : ['dist/test/**/*.test.js'])];
const suite = spawn(process.execPath, args, { stdio: 'inherit', detached: isPosix });
let interrupted = false;
let escalator;

function terminateGroup(signal) {
  try {
    if (isPosix && suite.pid) process.kill(-suite.pid, signal);
    else suite.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') console.error(`Unable to send ${signal}:`, error);
  }
}

function signalSuite(signal) {
  if (interrupted) return;
  interrupted = true;
  terminateGroup(signal);
  escalator = setTimeout(() => terminateGroup('SIGKILL'), 3000);
  escalator.unref();
}

function survivingGroupMembers() {
  if (!isPosix || !suite.pid) return [];
  const result = spawnSync('ps', ['-Ao', 'pid=,pgid=,stat=,comm='], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`Cannot inspect test processes: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout.split('\n').flatMap(line => {
    const parts = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return parts && Number(parts[2]) === suite.pid
      ? [{ pid: Number(parts[1]), state: parts[3], command: parts[4] }]
      : [];
  });
}

const onInt = () => signalSuite('SIGINT');
const onTerm = () => signalSuite('SIGTERM');
process.on('SIGINT', onInt);
process.on('SIGTERM', onTerm);
const exit = await new Promise(resolve => {
  suite.once('error', error => resolve({ code: 1, error }));
  suite.once('close', (code, signal) => resolve({ code, signal }));
});
process.off('SIGINT', onInt);
process.off('SIGTERM', onTerm);
if (escalator) clearTimeout(escalator);
if (exit.error) console.error('Cannot start Node test runner:', exit.error);

let leaked = false;
try {
  const survivors = survivingGroupMembers();
  if (survivors.length > 0) {
    leaked = true;
    console.error(`Test suite leaked ${survivors.length} process(es) (including orphans/zombies):`);
    for (const item of survivors.slice(0, 12)) console.error(`  PID ${item.pid} [${item.state}] ${item.command}`);
    if (survivors.length > 12) console.error(`  ... and ${survivors.length - 12} more`);
    terminateGroup('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 250));
    if (survivingGroupMembers().length > 0) terminateGroup('SIGKILL');
    console.error('Suite failed: leaked processes must be fixed in test teardown (t.after).');
  }
} catch (error) {
  leaked = true;
  terminateGroup('SIGKILL');
  console.error(error);
}
if (!isPosix) console.error('Warning: process-group leak detection is unavailable on Windows.');
process.exitCode = interrupted ? 130 : leaked ? 1 : (exit.code ?? 1);
