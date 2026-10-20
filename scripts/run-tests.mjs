#!/usr/bin/env node
/**
 * Runner de tests avec garde-fou de fuite de processus : exécute la suite du package
 * puis vérifie qu'aucun processus enfant direct ne survit. Un test qui laisse des
 * enfants vivants (le cas échéant des git orphelins qui deviennent des zombies
 * reparentés au PID 1 du bac à sable) fait échouer la suite au lieu d'empoisonner
 * l'environnement pour les runs suivants.
 */
import { spawn, spawnSync } from 'node:child_process';

const forward = spawnSync(process.execPath, ['--test', 'dist/test/**/*.test.js'], {
  stdio: 'inherit',
});
const suiteExit = forward.status ?? 1;

// Garde-fou : liste les enfants directs encore vivants après la suite.
const ps = spawnSync('ps', ['-eo', 'pid,ppid,stat,comm'], { encoding: 'utf8' });
if (ps.status === 0) {
  const own = process.pid;
  const leaked = ps.stdout.split('\n').slice(1)
    .map(line => line.trim().split(/\s+/))
    .filter(fields => fields.length >= 4 && fields[1] === String(own) && fields[2][0] !== 'Z')
    .map(fields => fields[3]);
  if (leaked.length > 0) {
    console.error(`Test suite leaked ${leaked.length} live child process(es): ${[...new Set(leaked)].join(', ')}`);
    process.exit(1);
  }
}
process.exit(suiteExit);
