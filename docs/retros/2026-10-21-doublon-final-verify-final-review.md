# Rétro — Redondance task-final-verify / final-review (run 3bf15735)

Date : 2026-10-21
Sources : `.scratch/git-tests/batch.json`, `packages/task-batches/src/taskBatch.ts:1228` (`finalReviewTask`), `packages/task-batches/src/taskBatchReport.ts:140`, `packages/task-batches/test/` (8 fichiers), harnais des exécuteurs.

## La redondance, mesurée

Deux tâches quasi identiques encadrent la fin de chaque lot « git-tests » :

- **task-final-verify** — tâche déclarée par l'auteur du lot dans `batch.json` : build complet + `npm test` + revue Standards/Spec du diff + correctifs + commit. Démarre après les implémentations.
- **final-review** — tâche synthétique générée automatiquement par le moteur pour **chaque** lot (`finalReviewTask()`, `source: 'final-review'`, `dependsOn` toutes les tâches) : revue code-review complète du diff base...HEAD + correctifs + exécution obligatoire des `validationCommands` avec la discipline stricte « chaque commande obligatoire, code de sortie zéro, ne remplace pas une commande pour obtenir un succès ».

Le lot paie donc **deux passes finales quasi identiques**, 10-25 min de worker chacune — perte sèche de ~15-25 min par run.

## Pourquoi la suppression de final-review (proposition initiale) inverse les garanties

1. **final-review est le filet de sécurité systémique** ; task-final-verify est optionnelle — l'auteur du lot peut l'oublier, mal la rédiger ou l'omettre. Supprimer la synthétique transfère la garantie « chaque lot est revu et validé en entier » vers la mémoire de chaque auteur de batch.
2. **Les trois harnais worker promettent** « the batch performs one final combined review of the integration branch » (`localTaskExecutor.ts:97`, `dockerTaskExecutor.ts:91`, `agent-pi:73`) — c'est le contrat qui justifie que les workers skippent leur revue par ticket. Sans final-review synthétique, la promesse devient fausse dans tout lot sans tâche de revue déclarée.
3. **Rayon de blast code** : 8 fichiers de test de task-batches référencent `final-review` (dont `finalReviewValidation.test.ts`, qui teste précisément sa discipline de validation), le manifeste de rapport compte `finalReview` séparément (`taskBatchReport.ts:140`), et la revue combinée finale est structurante dans le vocabulaire V2 (« Revue indépendante »).

## Candidats, par sévérité

1. **Recommandé — suppression au niveau du lot, pas du moteur** : retirer `task-final-verify` de ce `batch.json` et des prochains lots. La synthétique fait déjà le même travail, mieux encadré. Zéro code, zéro test à toucher, ~15-25 min gagnées par run. Pour un contrôle plus riche, enrichir `validationCommands` du batch — c'est l'extension prévue par le moteur.
2. **Si changement moteur** : ne pas supprimer la synthétique, mais la **dédupliquer explicitement** — flag opt-in sur une tâche du batch (ex. `"finalVerify": true`) signifiant au moteur « cette tâche tient le rôle de la revue finale, ne pas ajouter final-review ». Garantie par défaut conservée ; opt-out déclaratif et testable. Blast radius : `finalReviewTask()` + 1-2 tests + doc du guide coordinateur.
3. **À ne pas faire** : retirer `finalReviewTask()` du moteur. Casse la promesse des harnais, déplace la discipline de validation vers chaque auteur de lot, coûte 8 fichiers de test à réécrire — pour la seule tâche synthétique qui n'a causé aucun incident dans ce run.

## Décision en attente

- Retirer `task-final-verify` du `batch.json` des prochains runs.
- Éventuellement préparer le flag `finalVerify` (candidat 2) si le moteur doit évoluer.

## Addendum (même jour, 20:46) — Le doublon n'est pas qu'une perte de temps

La tâche `task-final-verify` a déclenché le même accident que la tentative 1 de task-integration : son prompt invoque `/skill:code-review`, le skill délègue en sous-agents via `pi-subagents`, ~60 erreurs enregistrées → l'attempt échouera probablement (règle « tout pi_subagent_error échoue l'attempt »). Le doublon n'est donc pas seulement coûteux, il est **le porteur du déclencheur** : sa suppression (candidat 1) élimine aussi ce chemin d'échec. Détail complet dans `2026-10-21-relance-task-integration.md` (addendum).

Dénouement : le run a été interrompu à 20:50 pendant final-verify, puis l'état du run supprimé à 20:55. Les implémentations survivent sur la branche d'intégration ; les deux passes finales restent à rejouer.
