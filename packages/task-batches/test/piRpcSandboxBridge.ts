/**
 * Pont faux-RPC pour les tests sandbox du transport Pi RPC natif (t06/t85/tick) :
 * le spawnRpc de l'exécuteur sandbox fait un VRAI `spawn('sbx')` que le
 * SubprocessExecutor injecté n'intercepte pas ; ce pont place un faux binaire `sbx`
 * sur le PATH portant un serveur RPC simulé (protocole JSONL sur stdio) et proxifie
 * le travail de chaque tâche Pi vers la fermeture `agent` du processus de test :
 * ses phrases `emit` sont ajoutées directement et synchrone au log stdout de la
 * tentative (preuves de la tentative, source « log » du Signal d'activité), ses
 * fichiers sont écrits dans le clone de la sandbox, et son code de sortie devient
 * le verdict SLOPIFY_RESULT de l'implémenteur. Les commandes de contrôle sbx
 * (create/exec/cp/rm) restent servies par le faux exécuteur injecté du test ; les
 * tâches codex ne changent pas de chemin. Aucun Docker, réseau ni appel fournisseur.
 */
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/** Fermeture agent de test : identifiant, clone de la tentative, émission de phrase, répertoire de travail. */
export type BridgeAgent = (id: string, sandbox: string, emit: (text: string) => void, cwd: string) => Promise<number>;

/** Source du faux serveur RPC : rôle par --append-system-prompt, revue approuvée après délégation parallèle, travail proxifié via le pont, arrêt ordonné borné. */
export const fakeSbxRpcServerScript = `#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const sandboxName = args.find((value, index) => index > 0 && value.startsWith('slopify-')) ?? '';
// La fixture simule le conteneur de tâche par un clone hôte <racine>/<sandbox> : le faux
// pi y écrit ses fichiers, comme le vrai pi écrit dans le workspace du conteneur.
const workdir = (process.env.SLOPIFY_FAKE_RPC_ROOT && sandboxName)
  ? path.join(process.env.SLOPIFY_FAKE_RPC_ROOT, sandboxName)
  : option('-w') ?? process.cwd();
const role = path.basename(option('--append-system-prompt') ?? '') === 'reviewer.md' ? 'reviewer' : 'implementer';
const bridge = process.env.SLOPIFY_FAKE_RPC_BRIDGE ?? '';
const emit = record => process.stdout.write(JSON.stringify(record) + '\\n');
let pendingPrompts = 0;
const stdin = createInterface({ input: process.stdin });
stdin.on('line', line => {
  let command;
  try { command = JSON.parse(line); } catch { return; }
  if (!command || command.type !== 'prompt') return;
  pendingPrompts += 1;
  void (async () => {
    try {
      emit({ id: command.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
      const message = String(command.message ?? '');
      if (role !== 'implementer') {
        // Reviewer : délégation parallèle Standards/Spec puis verdict approuvé, dans une session indépendante neuve.
        emit({ type: 'tool_execution_end', toolName: 'subagent', isError: false, result: { details: { mode: 'parallel', results: [
          { agent: 'standards', exitCode: 0, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Independent Standards findings' }] }] },
          { agent: 'spec', exitCode: 0, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Independent Spec findings' }] }] },
        ] } } });
        emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Independent review report\\nSLOPIFY_REVIEW={"verdict":"approved"}' }] } });
        emit({ type: 'agent_settled' });
        return;
      }
      // Implémenteur : le travail de la tâche est proxifié vers la fermeture agent du processus de test.
      const workId = String(Date.now()) + '-' + String(Math.trunc(Math.random() * 1e6));
      await writeFile(path.join(bridge, 'req-' + workId + '.json'), JSON.stringify({ workId, id: message, workdir }));
      const resultFile = path.join(bridge, 'res-' + workId + '.json');
      let result;
      for (;;) {
        try { result = JSON.parse(await readFile(resultFile, 'utf8')); break; } catch { /* travail en cours */ }
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      if (result.exitCode === 0) {
        // Corrections validées et commitées avant revue, comme l'exige le workflow.
        execFileSync('git', ['-C', workdir, 'add', '--all']);
        execFileSync('git', ['-C', workdir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fake pi rpc work']);
      }
      const text = result.exitCode === 0
        ? message + ' report\\nSLOPIFY_RESULT={"status":"succeeded"}'
        : 'Blocked by final validation\\nSLOPIFY_RESULT={"status":"failed","reason":"final validation failed"}';
      emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });
      emit({ type: 'agent_settled' });
    } catch (error) {
      process.stderr.write('fake pi rpc server failed: ' + String(error instanceof Error ? error.message : error) + '\\n');
      process.exitCode = 1;
    } finally { pendingPrompts -= 1; }
  })();
});
// Arrêt ordonné : fermeture du stdin = sortie au code zéro après le travail en vol,
// bornée court — un serveur orphelin ne survit jamais au canal qui le possède.
stdin.on('close', () => {
  const closedAt = Date.now();
  const finish = () => { if (pendingPrompts > 0 && Date.now() - closedAt < 2000) setTimeout(finish, 10); else process.exit(0); };
  finish();
});
`;

export interface FakeSbxRpcBridgeOptions {
  /** Racine du fixture : les clones de sandbox vivent à <root>/<sandboxName>, les runs à <root>/runs/<runId>. */
  root: string;
  /** Fermeture agent du test, exécutée dans le processus de test pour chaque tâche Pi. */
  agent: BridgeAgent;
}

/** Retrouve la tentative active depuis l'état durable du run : resource.sandboxName → répertoire du run et identifiant de tentative. */
async function findAttemptForSandbox(sandboxWorkdir: string): Promise<{ runDir: string; attemptId: string } | undefined> {
  const sandboxName = path.basename(sandboxWorkdir);
  try {
    const runsDir = path.join(path.dirname(sandboxWorkdir), 'runs');
    for (const runId of await readdir(runsDir)) {
      let state: { tasks?: Array<{ attempts?: Array<{ attemptId: string; status?: string; resource?: { sandboxName?: string } }> }> };
      try { state = JSON.parse(await readFile(path.join(runsDir, runId, 'state.json'), 'utf8')); }
      catch { continue; }
      for (const task of state.tasks ?? []) {
        const attempt = task.attempts?.find(candidate => candidate.resource?.sandboxName === sandboxName && candidate.status === 'running');
        if (attempt) return { runDir: path.join(runsDir, runId), attemptId: attempt.attemptId };
      }
    }
  } catch { /* runs non lisibles */ }
  return undefined;
}

/**
 * Installe le pont pour la durée du test : faux `sbx` sur le PATH, serveur RPC
 * simulé, répertoire d'échanges (requêtes, codes de sortie) et poller qui exécute
 * la fermeture agent de façon concurrente (les closures peuvent se bloquer sur des
 * gates indépendantes). les phrases émises rejoignent directement le log stdout de
 * la tentative, dérivé du chemin du workspace de la tentative. Les hooks `after`
 * sont enregistrés en LIFO : le pont s'arrête et restaure le PATH avant le
 * nettoyage de la racine.
 */
export async function installFakeSbxRpc(
  t: { after(fn: () => Promise<void>): void },
  options: FakeSbxRpcBridgeOptions,
): Promise<void> {
  const bridge = path.join(options.root, 'pi-rpc-bridge');
  const bin = path.join(options.root, 'pi-sbx-bin');
  await mkdir(bridge, { recursive: true });
  await mkdir(bin, { recursive: true });
  const serverScript = path.join(options.root, 'fake-sbx-rpc-server.mjs');
  await writeFile(serverScript, fakeSbxRpcServerScript, { mode: 0o600 });
  await writeFile(path.join(bin, 'sbx'), [
    '#!/bin/sh',
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(serverScript)} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  const handled = new Set<string>();
  let running = true;
  const poll = async (): Promise<void> => {
    if (!running) return;
    let entries: string[];
    try { entries = await readdir(bridge); } catch { return; }
    for (const entry of entries) {
      const match = /^req-(.+)\.json$/.exec(entry);
      if (!match || handled.has(entry)) continue;
      handled.add(entry);
      let request: { workId: string; id: string; workdir: string };
      try { request = JSON.parse(await readFile(path.join(bridge, entry), 'utf8')); }
      catch { continue; }
      void (async () => {
        // Chaque requête est traitée indépendamment : les closures peuvent se bloquer
        // sur des gates propres sans retarder les autres tâches de la même vague.
        try {
          const id = String(request.id).includes('code-review au diff complet') ? 'final-review' : String(request.id);
          // La tentative active est retrouvée dans l'état durable du run ; le cwd reçu
          // par la fermeture est le workspace hôte de la tentative, comme pour l'ancien
          // exécuteur one-shot, et les phrases rejoignent son log stdout synchrone.
          const attempt = await findAttemptForSandbox(request.workdir);
          const attemptLog = attempt ? path.join(attempt.runDir, 'attempts', attempt.attemptId, 'stdout.log') : undefined;
          const attemptCwd = attempt ? path.join(attempt.runDir, 'workspaces', attempt.attemptId) : request.workdir;
          const emitBridge = (text: string) => { if (attemptLog) try { appendFileSync(attemptLog, text + '\n'); } catch { /* tentative en nettoyement */ } };
          const exitCode = await options.agent(id, request.workdir, emitBridge, attemptCwd);
          await writeFile(path.join(bridge, `res-${request.workId}.json`), JSON.stringify({ exitCode }));
        } catch (error) {
          try { await writeFile(path.join(bridge, `res-${request.workId}.json`), JSON.stringify({ exitCode: 1, error: String(error) })); } catch { /* racine fermée */ }
        }
      })();
    }
  };
  const timer = setInterval(() => { void poll(); }, 10);
  timer.unref();
  const previousPath = process.env.PATH;
  const previousRoot = process.env.SLOPIFY_FAKE_RPC_ROOT;
  const previousBridge = process.env.SLOPIFY_FAKE_RPC_BRIDGE;
  process.env.PATH = bin + path.delimiter + (previousPath ?? '');
  process.env.SLOPIFY_FAKE_RPC_ROOT = options.root;
  process.env.SLOPIFY_FAKE_RPC_BRIDGE = bridge;
  t.after(async () => {
    running = false;
    clearInterval(timer);
    process.env.PATH = previousPath ?? '';
    if (previousRoot === undefined) delete process.env.SLOPIFY_FAKE_RPC_ROOT; else process.env.SLOPIFY_FAKE_RPC_ROOT = previousRoot;
    if (previousBridge === undefined) delete process.env.SLOPIFY_FAKE_RPC_BRIDGE; else process.env.SLOPIFY_FAKE_RPC_BRIDGE = previousBridge;
  });
}
