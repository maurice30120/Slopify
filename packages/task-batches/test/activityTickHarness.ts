/** Harnais partagé des tests du Signal d'activité (ADR 0013) : dépôt hôte préparé,
 * faux exécuteur sbx seul (clones, commits, checkpoints et branches publiées sont
 * du vrai Git) et horloge manuelle injectée. Partagé par le test du tick du service
 * d'exécution et par la démonstration de bout en bout. */

import assert from 'node:assert/strict';
import { configureRecreatedWorkers } from './recreatedWorkerFixture.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { SubprocessExecutor } from '@slopify/execution';
import type { BatchTask } from '@slopify/task-batches';
import type { ActivityTickClock } from '@slopify/activity';

export function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

export function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

export const task = (id: string, agent: 'pi' | 'codex', dependsOn: string[] = []): BatchTask => ({
  id, agent, dependsOn, prompt: id, source: `${id}.md`,
});

/** Horloge manuelle : le temps n'avance que quand le test le décide, tick rapide et déterministe. */
export class ManualActivityClock implements ActivityTickClock {
  private waiters: Array<() => void> = [];
  private instant = new Date('2026-01-01T00:00:00Z');
  /** Nombre de ticks réellement levés pendant la commande : prouve que le tick a tourné. */
  firedTicks = 0;
  now(): Date { return new Date(this.instant); }
  wait(_intervalMs: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      if (signal.aborted) return resolve();
      const settle = () => {
        const index = this.waiters.indexOf(settle);
        if (index >= 0) this.waiters.splice(index, 1);
        signal.removeEventListener('abort', settle);
        resolve();
      };
      signal.addEventListener('abort', settle, { once: true });
      this.waiters.push(settle);
    });
  }
  /** Avance le temps d'une minute et lève chaque tick en attente ; l'émission rend la main au test. */
  async advanceMinute(): Promise<void> {
    this.instant = new Date(this.instant.getTime() + 60_000);
    const waiting = this.waiters.splice(0);
    this.firedTicks += waiting.length;
    for (const settle of waiting) settle();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

export interface PreparedHost {
  root: string;
  repo: string;
  head: string;
  skills: string;
  batchFile: string;
}

/** Prépare le dépôt hôte de base : init, commit initial, skills officiels, spec et lot. */
export async function prepareSlopifyFixture(
  prefix: string,
  t: { after(fn: () => Promise<void>): void },
  tasks: BatchTask[],
): Promise<PreparedHost> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'host');
  execFileSync('git', ['init', '-q', repo]);
  await configureRecreatedWorkers(repo);
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(repo, 'base.txt'), 'committed base');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const head = git(repo, 'rev-parse', 'HEAD');
  const skills = path.join(root, 'official-skills');
  await mkdir(path.join(skills, 'code-review'), { recursive: true });
  await writeFile(path.join(skills, 'code-review', 'SKILL.md'), 'Official review reference');
  await writeFile(path.join(root, 'spec.md'), '# Approved specification');
  const batchFile = path.join(root, 'batch.json');
  await writeFile(batchFile, JSON.stringify({ specFile: 'spec.md', tasks }));
  return { root, repo, head, skills, batchFile };
}

/** Agent de test : identifiant de tâche, clone de la tentative, émission de log, répertoire de travail. */
export type TestAgent = (id: string, sandbox: string, emit: (text: string) => void, cwd: string) => Promise<number>;

export interface FakeSbxOptions {
  root: string;
  skills: string;
  agent: TestAgent;
  sandboxes: Map<string, string>;
  /** Observateur des commandes sbx, appelé avant le traitement. */
  onSbx?: (args: string[]) => Promise<void>;
  /** Collecteur optionnel des tâches lancées (identifiants de prompt). */
  launched?: string[];
  /** Collecteur optionnel des sandboxes supprimés. */
  removed?: string[];
}

/** Faux exécuteur sbx seul : tous les clones, commits, checkpoints et branches publiées sont du vrai Git. */
export function fakeSbxExecutor(options: FakeSbxOptions): SubprocessExecutor {
  return async request => {
    if (request.command === 'git') {
      const r = spawnSync('git', request.args, { cwd: request.cwd, encoding: 'utf8' });
      return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    }
    assert.equal(request.command, 'sbx');
    const a = request.args;
    await options.onSbx?.(a);
    const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
    if (a[0] === 'version') return ok('sbx 0.47.0');
    if (a.includes('--help')) return ok('--clone --skills --json policy init');
    if (a[0] === 'policy') return ok('{"initialized":true}');
    if (a[0] === 'skills') return ok(JSON.stringify({ store: options.skills, skills: ['implement', 'tdd', 'code-review'] }));
    if (a[0] === 'kit') return ok('{}');
    if (a[0] === 'ls') return ok('[]');
    if (a[0] === 'create') {
      const name = a[a.indexOf('--name') + 1];
      const sandbox = path.join(options.root, name);
      execFileSync('git', ['clone', '-q', request.cwd!, sandbox]);
      git(request.cwd!, 'remote', 'add', `sandbox-${name}`, sandbox);
      options.sandboxes.set(name, sandbox);
      return ok();
    }
    if (a[0] === 'rm') { options.removed?.push(a.at(-1)!); return ok(); }
    if (a[0] === 'cp') {
      if (a.at(-1)?.endsWith('codex-sessions')) {
        await mkdir(a.at(-1)!);
        await writeFile(path.join(a.at(-1)!, 'native.jsonl'), '{"type":"response_item"}\n');
      }
      return ok();
    }
    if (a[0] === 'exec') {
      const name = a.find((v: string) => options.sandboxes.has(v));
      const sandbox = name ? options.sandboxes.get(name)! : undefined;
      assert.ok(sandbox, 'execution uses its own created sandbox');
      const index = a.indexOf('git');
      if (index >= 0) {
        const r = spawnSync('git', a.slice(index + 1), { cwd: sandbox, encoding: 'utf8' });
        return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      }
      if (a.some((v: string) => v.includes('npm root -g'))) return ok('/opt/pi/examples/extensions/subagent/index.ts\n');
      if (a.includes('sh') && a.some((v: string) => v.includes('$HOME/.codex/sessions'))) return ok('/home/agent/.codex/sessions');
      if ((a.includes('codex') && a.includes('--json')) || (a.includes('pi') && a.includes('--print'))) {
        const id = String(a.at(-1)).includes('code-review au diff complet') ? 'final-review' : a.at(-1)!.replace(/^(?:\/skill:implement |\$implement\n\n)/, '');
        options.launched?.push(id);
        const emit = (text: string) => request.onOutput?.('stdout', `${text}\n`);
        const exitCode = await options.agent(id, sandbox, emit, request.cwd!);
        const stdout = a.includes('pi')
          ? JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `${id} report\nSLOPIFY_RESULT={"status":"succeeded"}` }] } })
          : JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `${id} report\nSLOPIFY_RESULT={"status":"succeeded"}` } });
        request.onOutput?.('stdout', stdout + '\n');
        return { exitCode, stdout: stdout + '\n', stderr: exitCode ? `${id} failed` : '' };
      }
      return ok();
    }
    throw new Error(`Unhandled sbx ${a.join(' ')}`);
  };
}
