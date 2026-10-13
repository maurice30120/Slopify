import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { extractActivityGitSignal } from '../src/activitySignalGit.js';

function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

/** Un clone de tentative propre, base des états suivants. */
async function fixtureClone(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-activity-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'clone');
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(repo, 'a.txt'), 'a\n');
  await writeFile(path.join(repo, 'c.txt'), 'c\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'initial');
  return { root, repo };
}

/** Le premier signal d'un clone modifié, base des deltas suivants. */
async function premierSignal(repo: string) {
  await writeFile(path.join(repo, 'a.txt'), 'a modifie\n');
  const signal = await extractActivityGitSignal(repo, null);
  assert.ok(signal.snapshot);
  return signal;
}

test('decrit le delta entre deux snapshots par une phrase mecanique', async (t) => {
  const { repo } = await fixtureClone(t);
  const first = await premierSignal(repo);

  await writeFile(path.join(repo, 'b.txt'), 'b\n');
  rmSync(path.join(repo, 'c.txt'));

  const second = await extractActivityGitSignal(repo, first.snapshot);

  assert.equal(second.phrase, '1 fichier créé, 1 supprimé (b.txt, c.txt)');
});

test('un etat inchangé entre deux signaux produit « pas de delta »', async (t) => {
  const { repo } = await fixtureClone(t);
  const first = await premierSignal(repo);

  const second = await extractActivityGitSignal(repo, first.snapshot);

  assert.equal(second.phrase, null);
  assert.ok(second.snapshot);
});

test('un clone propre ne produit pas de delta dès le premier signal', async (t) => {
  const { repo } = await fixtureClone(t);
  const signal = await extractActivityGitSignal(repo, null);
  assert.equal(signal.phrase, null);
  assert.ok(signal.snapshot);
  assert.deepEqual(signal.snapshot.statuses, {});
});

test('un même fichier dont le statut porcelain évolue reste un delta', async (t) => {
  const { repo } = await fixtureClone(t);
  const first = await premierSignal(repo);
  git(repo, 'add', 'a.txt');

  const second = await extractActivityGitSignal(repo, first.snapshot);

  assert.equal(second.phrase, '1 fichier modifié (a.txt)');
});

test("tout échec de la commande git se résout en « pas de delta » sans exception", async (t) => {
  const { repo } = await fixtureClone(t);
  const first = await premierSignal(repo);

  const cloneDisparu = path.join(repo, '..', 'inexistant');
  const signalSansRepo = await extractActivityGitSignal(cloneDisparu, first.snapshot);
  assert.deepEqual(signalSansRepo, { phrase: null, snapshot: null });
});

test('un chemin hors de tout dépôt git se résout en « pas de delta » sans exception', async (t) => {
  const horsDepot = await mkdtemp(path.join(tmpdir(), 'slopify-hors-depot-'));
  t.after(() => rm(horsDepot, { recursive: true, force: true }));
  const signal = await extractActivityGitSignal(horsDepot, null);
  assert.deepEqual(signal, { phrase: null, snapshot: null });
});

test('borne la phrase sur une ligne en tronquant les noms quand ils sont trop nombreux', async (t) => {
  const { repo } = await fixtureClone(t);
  for (let i = 1; i <= 5; i++) {
    await writeFile(path.join(repo, `f${i}.txt`), `f${i}\n`);
  }

  const signal = await extractActivityGitSignal(repo, null);

  assert.ok(signal.phrase);
  assert.equal(signal.phrase, '5 fichiers créés (f1.txt, f2.txt, f3.txt + 2 autres)');
  assert.ok(!signal.phrase.includes('\n'));
});

test('tronque un nom de fichier trop long et borne la longueur totale de la phrase', async (t) => {
  const { repo } = await fixtureClone(t);
  const longName = `${'tres-long-'.repeat(10)}.txt`;
  await writeFile(path.join(repo, longName), 'long\n');

  const signal = await extractActivityGitSignal(repo, null);

  assert.ok(signal.phrase);
  assert.ok(signal.phrase.length <= 201, `phrase trop longue: ${signal.phrase.length}`);
  assert.ok(!signal.phrase.includes(longName));
  assert.ok(signal.phrase.includes('…'));
  assert.ok(!signal.phrase.includes('\n'));
});

test('decrit un renommage comme renommé, du point de vue du nouveau nom', async (t) => {
  const { repo } = await fixtureClone(t);
  git(repo, 'mv', 'c.txt', 'renomme.txt');

  const signal = await extractActivityGitSignal(repo, null);

  assert.equal(signal.phrase, '1 fichier renommé (renomme.txt)');
});

test("un snapshot d'une autre tentative est ignoré : le delta repart de l'état courant", async (t) => {
  const { repo } = await fixtureClone(t);
  const autreTentative = await fixtureClone(t);
  await writeFile(path.join(autreTentative.repo, 'a.txt'), 'a modifie ailleurs\n');
  const autrePremier = await extractActivityGitSignal(autreTentative.repo, null);
  assert.ok(autrePremier.snapshot);

  await writeFile(path.join(repo, 'a.txt'), 'a modifie ici\n');
  const signal = await extractActivityGitSignal(repo, autrePremier.snapshot);

  assert.equal(signal.phrase, '1 fichier modifié (a.txt)');
});

test('un fichier redevenu propre ne fait plus partie du delta', async (t) => {
  const { repo } = await fixtureClone(t);
  const first = await premierSignal(repo);
  git(repo, 'checkout', '--', 'a.txt');

  const second = await extractActivityGitSignal(repo, first.snapshot);

  assert.equal(second.phrase, null);
  assert.ok(second.snapshot);
  assert.deepEqual(second.snapshot.statuses, {});
});

test('capture le statut porcelain du clone comme snapshot du signal', async (t) => {
  const { repo } = await fixtureClone(t);
  await writeFile(path.join(repo, 'a.txt'), 'a modifie\n');
  await writeFile(path.join(repo, 'new.txt'), 'nouveau\n');
  rmSync(path.join(repo, 'c.txt'));

  const signal = await extractActivityGitSignal(repo, null);

  assert.ok(signal.snapshot);
  assert.equal(signal.snapshot.clonePath, repo);
  assert.deepEqual(signal.snapshot.statuses, {
    'a.txt': ' M',
    'new.txt': '??',
    'c.txt': ' D',
  });
});
