# Retour de session — 2026-10-14

## Incident : crash du terminal pendant `slopify tasks run`

**Quand** : ~13:45, pendant la vague 3 du run `d015cb55-b5dd-4e54-a984-7399b7ca80dd` (repo codetour, spec « Tour Step Conversation via ACP et Vibe », 11 tâches + final-review).

**Quoi** : le terminal qui portait le processus principal `slopify tasks run` a crashé. Le processus est mort avec lui, emportant les `sbx exec` en cours.

**Conséquences observées à 14:10** :
- 6 tâches succeeded (t01→t04, t08, t09) — checkpoints sains, rien de perdu.
- t05 relancé manuellement à 13:47 via `slopify tasks resume-task … t05-followup-step-conversations --json` (terminal s003) — tourne normalement.
- **t06, t07, t10 : tentatives orphelines**. Toujours marquées `running` dans `state.json` alors que leurs sandboxes sbx sont `stopped` depuis ~13:28-13:45 (les `sbx exec` sont morts avec le parent). Aucun checkpoint produit ; le travail non commité de ces tentatives est perdu ; le travail commité dans les clones reste récupérable via `refs/sandboxes/<nom>/*` tant que les sandboxes ne sont pas supprimées.

**État du run au moment de l'incident** :
```
succeeded : t01, t02, t03, t04, t08, t09   (6/11)
running    : t05 (repris, actif)
orphelines : t06, t07, t10
pending    : final-review
vagues     : 1 (t01,t02) → 2 (t03,t08,t09) → 3 (t04→t07,t10) → 4 (final-review)
```

## Reprise à faire

1. Laisser finir t05 (actif, en TDD sur `stepChatAcp.test.js`).
2. Reprise explicite des orphelines — une tentative marquée `running` doit d'abord être arrêtée :
   ```
   slopify tasks resume-task d015cb55-b5dd-4e54-a984-7399b7ca80dd t06-stop-button
   slopify tasks resume-task d015cb55-b5dd-4e54-a984-7399b7ca80dd t07-navigation-cancellation
   slopify tasks resume-task d015cb55-b5dd-4e54-a984-7399b7ca80dd t10-agent-error-handling
   ```
3. `final-review` part quand les 10 tâches sont vertes.
4. Avant tout `sbx rm` des sandboxes orphelines : vérifier `refs/sandboxes/<nom>/*` ou faire `git fetch sandbox-<nom>` (mode `--clone` : les commits non fetchés sont perdus à la suppression).

## Effet secondaire confirmé (15:33) : statuts désynchronisés

Les reprises de t07 et t10 **ont réussi** (checkpoints persistés : t07 via `refs/slopify/checkpoints/slopify-cfde0c23…`, t10 commit `2112895`), mais `state.json` n'a pas été réconcilié :

- t07 marquée `failed` alors que sa tentative `e5b80b6c` est `succeeded` avec checkpoint valide.
- t10 marquée `running` avec seulement l'ancienne tentative orpheline listée (la réussite `eb16a6f5` n'y figure pas).
- `final-review` marquée `blocked` à cause du `failed` de t07.

Les processus `resume-task` de t07 et t10 sont morts après avoir persisté l'attempt mais pas le statut de tâche. **Bug Slopify à tracker** : `resume-task` peut terminer une tentative avec succès sans mettre à jour le statut de la tâche parente.

Recommandation pour repartir proprement (une fois t06 vert) :
```
slopify tasks resume d015cb55-b5dd-4e54-a984-7399b7ca80dd --json
```

## Effet secondaire confirmé (15:50) : course d'intégration entre `resume-task` concurrents

t06 a **réussi** (299/299 tests, checkpoint `f83520d`, verdict `SLOPIFY_RESULT succeeded`) mais sa tâche est marquée `failed` avec le diagnostic `integration_failed` :

```
git update-ref refs/heads/feature/slopify-d015cb55… f83520d fcf3e8e
fatal: update_ref failed … is at 21128953… but expected fcf3e8e…
```

`2112895` est le checkpoint de **t10**, intégré en parallèle par l'autre processus `resume-task` pendant que t06 intégrait. Le CAS (update-ref old-value) a fait son travail — pas de corruption — mais la tâche est marquée échec alors que son checkpoint est valide, et la branche d'intégration ne contient que t10.

**Bug Slopify à tracker** : deux `resume-task` concurrents sur le même run intègrent en concurrence sur la même branche d'intégration ; le perdant passe `failed` sans réintégration. Un `resume` complet (relancé à 15:50, processus d'arrière-plan) doit réutiliser le checkpoint de t06 et le fusionner.

## Fragilité réseau (16:15)

La reprise complète de t10 (tentative eaa8895c, relancée de zéro car la réussite précédente n'était pas persistée) a échoué sur `pi_provider_error: fetch failed` — erreur réseau transitoire vers le provider Mistral après ~20 min de travail. Une tentative complète peut donc être perdue sur un simple échec de fetch, sans retry automatique. Un `resume` complet a été relancé à 16:15 pour t06, t07 et t10 ensemble.

## Résultat du `resume` complet (16:25) : conflit d'intégration sur t06

Le `resume` (exit 2) a réintégré avec succès **t07** (statut `completed`) mais t06 est passé **`conflicted`** :

```
integration_conflict — src/player/markdown.ts, src/player/stepChat.test.ts,
src/player/stepChat.ts, src/player/stepChatAcp.test.ts, src/player/tourWebview.ts
```

Le checkpoint de t06 (`f83520d`, 299/299 tests verts) a été construit sur un état antérieur de l'intégration ; la branche a depuis bougé (t07, t10). Résolution explicite requise — les lancements sont suspendus (t10 `pending` et `final-review` attendent).

```
slopify tasks conflict d015cb55-b5dd-4e54-a984-7399b7ca80dd --json
slopify tasks resolve-conflict d015cb55-b5dd-4e54-a984-7399b7ca80dd --strategy manual
# puis relecture humaine des 5 fichiers, puis :
slopify tasks validate-resolution d015cb55-b5dd-4e54-a984-7399b7ca80dd <resolution-id>
slopify tasks resume d015cb55-b5dd-4e54-a984-7399b7ca80dd --json
```

## Leçon pour Slopify

Un run de plusieurs heures ne doit pas dépendre de la survie d'un terminal :
- le processus d'orchestration devrait survivre à son terminal (détachement, daemon, ou relance auto des tentatives interrompues au démarrage suivant) ;
- les tentatives interrompues sont détectables (sandbox stopped + statut `running` > seuil) : c'est le même mécanisme que le **Signal d'activité** (voir CONTEXT.md) — l'inactivité détectée devrait déclencher une reprise explicite plutôt qu'un gel silencieux.
