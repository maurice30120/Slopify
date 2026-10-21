# Rétro — Échec de task-integration et relance technique (run 3bf15735)

Date : 2026-10-21
Run : `3bf15735-7b0a-43c0-b399-af39d73a75aa` (batch git-tests, issues #178/#179/#180, mode local)
Sources primaires : `state.json` du run, `attempts/3bf34110/stdout.log` (20 000+ lignes), `harness.txt`, `packages/execution-local/src/localTaskExecutor.ts`, `.agents/skills/code-review/SKILL.md`.

## Contexte

Le lot « git-tests » contient deux tâches d'implémentation (task-checkpoints pour #179, task-integration pour #180) suivies de task-final-verify et final-review. task-checkpoints a réussi du premier coup (worker sans délégation, revue en ligne acceptée). task-integration a échoué à la fin de sa première tentative, provoquant une relance technique via `tasks resume`.

## Chaîne causale de l'échec (tentative 3bf34110)

1. Le worker termine l'implémentation : commit `90b2d44`, 486 lignes dans `packages/git/test/runGitOperations.test.ts`, suite `@slopify/git` 25/25 verts, revue Standards/Spec exécutée en ligne.
2. Il décide d'exécuter le skill `code-review` — dernière étape du skill `implement`. Ce skill exige « les deux axes en sous-agents parallèles ».
3. Ses appels à l'outil `subagent` natif de Pi sont mal formés : `worktree` placé dans les options au lieu du champ racine. Pi rejette : `'worktree' is a top-level field, not an option. Valid options: ...` (60+ options).
4. Le worker réessaie **20 fois la même forme**, sans jamais corriger, consulte en secours la doc du plugin installé `pi-subagents` (`~/.pi/agent/npm/node_modules/pi-subagents/`), puis renonce et fait la revue en ligne.
5. Verdict final correct : `SLOPIFY_RESULT={"status":"succeeded"}`, Pi se termine proprement (`agent_settled`, `aborted:false`).
6. Le harnais classe l'attempt en échec : règle de `localTaskExecutor.ts:118` — *exit code non nul OU tout diagnostic autre que `codex_evidence_unavailable`* échoue l'attempt. Les 14 `pi_subagent_error` suffisent. L'`exitCode: 1` enregistré est synthétisé (`run.exitCode || 1`).
7. Pas de checkpoint créé → tâche échouée → `tasks resume` → relance à partir de la base de #179 (`2dd9397`). La tentative 2 a réussi en ~17 min.

## Facteurs racines

1. **Le harnais local n'avait pas l'instruction de skip que le harnais sandbox Pi a.** `agent-pi/src/index.ts:73` disait « Skip the implement skill's final /code-review step » ; `localTaskExecutor.ts:97` ne disait que « not required » — une négation faible que le worker a lue comme « facultatif ». La formulation positive manquait.
2. **L'outil `subagent` natif de Pi est totalement non documenté.** Aucune mention dans le README ni les 30+ fichiers de `docs/` de Pi. Le modèle n'avait aucune référence de schéma pour se corriger ; son seul retour était le message d'erreur.
3. **Le skill `code-review` enseigne la délégation** (« Spawn both sub-agents in parallel ») alors que le lot possède déjà une revue combinée finale — le worker a suivi le skill en toute bonne foi.

## Correctif appliqué — puis réverté par le cleanup du run

`localTaskExecutor.ts:97` et `dockerTaskExecutor.ts:91` : la phrase « Independent per-ticket Standards/Spec reviews are not required » devient « **Skip the implement skill's final /code-review step:** independent per-ticket Standards/Spec reviews are not required; the batch performs one final combined review of the integration branch. » — aligné sur le harnais sandbox Pi. Builds OK dans les deux `dist/`. Aucun test ne verrouille ce libellé (voir rétro de session, candidat 1).

**Attention** : le cleanup du run à 20:55 a réverté ce correctif dans les fichiers sources (le `dist` recompilé l'a contenu un temps, mais rien n'est commité). **À réappliquer avant le prochain run.**

## Leviers d'accélération mesurés (profil d'une tentative de worker, ~25 min)

| Phase | Durée observée |
|---|---|
| Exploration spec/ADR/code | ~5-6 min |
| Écriture des tests | ~5-8 min |
| `npm test` complet du monorepo | ~8 min |
| Détour code-review (supprimé par le correctif) | ~4 min |
| Rapport final | ~2 min |

Leviers suivants, par gain décroissant (à décider) :

1. **Validation ciblée par worker** (~8 min/worker) : le harnais exige « targeted validation, full suite, then commit » alors que final-verify rejoue déjà la suite complète. Toucherait au contrat de tests (AGENTS.md : « ciblés puis npm test ») — choix de spec.
2. **Relance avec réutilisation du travail** (~25 min/échec) : exposer en lecture seule le rapport/workspace de la tentative échouée à la relance.
3. **Cache de build par workspace** : chaque tentative repart d'un clone vierge avec `npm ci` + build complet.

## Décisions à ne pas toucher

La règle stricte « tout diagnostic de sous-agent échoue l'attempt, quel que soit le verdict final » est **conforme à la spec** (pas de dégradation cachée). Les vrais bugs sont en amont (instructions du harnais, skill, absence de doc de l'outil natif), pas dans la politique d'échec.

## Note sur Pi

L'outil `subagent` natif supporte les worktrees isolés (champ racine de l'appel). Le plugin `pi-subagents` (déjà installé sur le poste, consulté par le worker comme doc de secours) est documenté ; si un jour les workers doivent déléguer, pointer le harnais vers son SKILL.md serait plus fiable que l'outil natif non documenté.

## Addendum (même jour, 20:46) — Récidive sur task-final-verify

Le même schéma d'échec s'est reproduit sur `task-final-verify` (attempt `be9c59e0`, démarré 20:12) pendant que la rétro était en cours d'écriture :

- Le worker a délégué massivement via le **plugin `pi-subagents`** (runner peer `subagent-runner-bootstrap.js` spawné) : **~51 exécutions de l'outil `subagent`, dont 60 événements `isError:true`** contre 40 réussis. Erreurs typiques : « Unknown agent 'general-purpos...' » (nom d'agent tronqué/incorrect), erreurs de workflow.
- **Déclencheur différent de la tentative 1** : le prompt de la tâche (déclarée dans `batch.json`) invoque explicitement `/skill:code-review`, et ce skill impose les deux axes en sous-agents parallèles. Ce n'est plus l'étape finale du skill `implement` mais une tâche dont le prompt commande directement la revue.
- **Le correctif du harnais ne couvre pas ce cas** : (a) la CLI en cours (`tasks resume` démarré 19:54) tourne sur l'ancien `dist`, antérieur à la recompilation ; (b) le libellé « Skip the implement skill's final /code-review step » vise l'étape finale du skill implement, pas une tâche batch qui demande code-review d'elle-même.
- **Même la `final-review` synthétique est exposée** : son prompt généré par `finalReviewTask()` demande aussi « applique le skill officiel code-review au diff complet ».

### Dénouement (20:50-20:55)

Le run a été **interrompu** à 20:50 pendant final-verify (statut `interrupted`, CLI et worker arrêtés), puis l'état du run (`state.json`, `activity.jsonl`, `context/`) a été **supprimé à 20:55** — plus reprise possible. Ce qui survit : la branche d'intégration `feature/slopify-3bf15735-7b0a-43c0-b399-af39d73a75aa` avec les commits `b3875c2` (tests #179), `2dd9397`, `a3a293d` (tests #180) et `d07edee` (commit d'intégration) — les deux implémentations sont validées et intégrées ; manquent les passes final-verify/final-review.

### Correctifs durables qui en découlent (consolidés)

1. **Brancher le skill `code-review` sur un mode « harnais automatisé → revue en ligne »** (dans `.agents/skills/code-review/SKILL.md`) : c'est le seul correctif qui protège *tous* les chemins — implement, task-final-verify, final-review synthétique. Les prompts des tâches continueront d'invoquer le skill ; c'est le skill qui doit s'adapter au contexte, pas chaque prompt.
2. **Supprimer `task-final-verify` du `batch.json`** (voir `2026-10-21-doublon-final-verify-final-review.md`) : retire le déclencheur le plus direct et économise une passe complète.
3. Le correctif de libellé du harnais (implémenté) reste utile pour l'étape implement, mais il est désormais démontré **insuffisant seul** : le schéma d'échec se déplace vers tout prompt qui invoque code-review.
