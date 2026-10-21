# Rétro de session — Surveillance du run 3bf15735 + correctifs d'accélération

Date : 2026-10-21
Portée : session de surveillance du run `3bf15735` (batch git-tests) et travail de correction qui en a découlé.
Sources : traces du run, `packages/execution-local`, `packages/execution-sandbox`, `.github/workflows/ci.yml`, `scripts/run-tests.mjs`.

## Candidats par sévérité

### 1. Les deux exécuteurs n'ont aucun test alors qu'ils portent le contrat le plus critique (Automated checks)

`@slopify/execution-local` et `@slopify/execution-sandbox` ont un script `test` (`node ../../scripts/run-tests.mjs`, glob `dist/test/**/*.test.js`) mais **zéro fichier de test** — aucun `.test.ts` dans les deux paquets. Le texte du harnais worker — exactement ce qui a causé l'échec de la tentative 1 — n'est verrouillé par rien d'autre que `tsc`. Le correctif du 2026-10-21 (skip du `/code-review`) peut régresser silencieusement.

**Candidat** : un test unitaire mécanique par exécuteur qui importe le harnais généré et affirme la présence de « Skip the implement skill's final /code-review step » et du marqueur `SLOPIFY_RESULT`. ~10 lignes, effet permanent.

### 2. Pas de garde-fou au commit local (Automated checks)

Session : une édition (apostrophe non échappée dans une chaîne simple-quote) a cassé la compilation de `execution-local`. `tsc` l'a détectée, mais (a) la première commande de build (`npm run build ... | tail -3 && echo BUILD_OK`) a affiché `BUILD_OK` malgré l'échec — le pipe masquait le code de sortie ; (b) rien ne s'exécute au commit. La CI existe et est saine (build+tests sur push/PR, ubuntu+macos, `cancel-in-progress`), mais le retour d'échec n'arrive qu'au push.

**Candidats** : hook pre-commit typecheck sur fichiers staged (le skill `setup-pre-commit` est déjà dans le repo). Discipline shell : ne jamais faire passer un build par `tail` quand le succès compte ; sans `pipefail`, le pipe masque les codes de sortie.

### 3. `commands.jsonl` : évidence déclarée, souvent vide, nom trompeur (Information access)

Le harnais dit au worker « Observed harness commands: …/commands.jsonl. Keep them intact as evidence for the final combined review ». Mais le fichier n'enregistre **que les sous-processus du harnais lui-même** (wrapper `logged`, `localTaskExecutor.ts:60`), pas les commandes du worker — et il est vide pour toute tentative qui n'atteint pas le checkpoint (tentative échouée 3bf34110 : 0 octet). En diagnostic, on s'attend à y trouver les commandes de l'agent ; c'est du temps perdu.

**Candidat** : renommer en `harness-commands.jsonl` ou une ligne dans le guide coordinateur (`docs/agents/coordinator-pi.md`) précisant son contenu réel.

### 4. Le skill `code-review` reste exposé aux workers avec son instruction de spawn (Coding standards / docs)

Le harnais dit maintenant « skip », mais chaque checkout privé contient le skill qui dit « Spawn both sub-agents in parallel ». Un worker zélé peut encore le charger et retenter la délégation.

**Candidat** : branche « harnais automatisé → revue en ligne » dans `.agents/skills/code-review/SKILL.md`, ou exclusion du skill des checkouts workers.

**Confirmé le même jour (20:46)** : task-final-verify a délégué via le plugin `pi-subagents` avec ~60 erreurs de sous-agents — même schéma que la tentative 1, déclenché cette fois par le prompt de la tâche qui invoque `/skill:code-review` directement. Détail dans `2026-10-21-relance-task-integration.md` (addendum). Le correctif de libellé du harnais est nécessaire mais insuffisant seul ; le correctif dans le SKILL.md devient le levier prioritaire.

### 5. Navigation — le pointeur existait déjà (non-finding)

`AGENTS.md` pointe vers `docs/agents/coordinator-pi.md` pour lancer/suivre/reprendre les lots ; il n'a pas été lu avant de grep-per le code source (~15 min d'exploration évitables). Rien à changer dans le repo.

## Corrections appliquées pendant la session

- `localTaskExecutor.ts:97` et `dockerTaskExecutor.ts:91` : instruction « Skip the implement skill's final /code-review step » ajoutée (détail dans `2026-10-21-relance-task-integration.md`).
- Builds des deux paquets OK ; suite de tests complète volontairement non rejouée pendant le run pour ne pas voler de CPU aux workers en cours.
- **Note** : le cleanup du run à 20:55 a réverté le correctif de libellé dans les sources (aucun commit ne le contient) — à réappliquer avant le prochain run.

## Fin du run (pour mémoire)

Le run a été interrompu à 20:50 pendant final-verify (récidive du schéma de sous-agents, voir addendum de `2026-10-21-relance-task-integration.md`), puis l'état du run a été supprimé à 20:55 (plus de reprise possible). Les implémentations #179/#180 sont validées et intégrées sur `feature/slopify-3bf15735-7b0a-43c0-b399-af39d73a75aa` (commits `b3875c2`, `a3a293d`, intégration `d07edee`) ; les passes final-verify/final-review manquent.

## Décisions en attente

- Levier « validation ciblée par worker » (~8 min/worker) : touche au contrat de tests, choix de spec.
- Levier « relance avec réutilisation du travail » (~25 min/échec).
- Levier « cache de build par workspace ».
- Suppression de `task-final-verify` du `batch.json` (voir `2026-10-21-doublon-final-verify-final-review.md`).
- Patch du skill `code-review` (mode « revue en ligne en harnais automatisé ») — devenu le levier prioritaire après la récidive sur final-verify.
