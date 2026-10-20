# Validation Slopify V2 — vagues de cinq

Validation du 7 octobre 2026.

- `npm run build` : réussi.
- `npm test` : 397 tests réussis, aucun échec ou test ignoré (123 pipeline, 30 runtime, 61 sandbox, 24 workspace, 159 Slopify).
- Tests avec Git réel et transport `sbx` simulé : sept tâches mixtes, cinq départs dans la première vague, aucune intégration avant la fin de celle-ci, deux départs après intégration, ordre du JSON, bases communes et reprise explicite sans réexécution de la tâche déjà réussie.
- Tests conservés : validation préalable, échec indépendant, descendants bloqués, checkpoints durables, conflits et résolutions, reprise. Tests CLI : anciens parcours refusés, codes 0/1/2 et propagation de SIGINT.
- `git diff --check` : réussi.

## Essai Docker réel

Commande : `node slopify/smoke/task-batch.mjs` (après build).

L’essai utilise un dépôt temporaire indépendant, avec une tâche Pi et une tâche Codex sans dépendance. Les deux sandboxes ont été créés et leurs agents ont exécuté leur tâche. Les deux tâches ont réussi avec des checkpoints intégrés, des rapports sauvegardés et des ressources supprimées après réussite. La branche et les fichiers du workspace hôte ont été préservés. Le contenu exact des deux fichiers, y compris le saut de ligne final, a été vérifié.

Run : `54e9a2a3-f17b-4d04-b0ea-3a73968706d7`. Code de sortie : `0`. Statut : `succeeded`.
Branche : `feature/slopify-54e9a2a3-f17b-4d04-b0ea-3a73968706d7`.
Base commune : `d6f68973b195303e7efb48de48a3113d4fb6e4e4`.
Commit intégré final : `e40ce655ac8043a2f3d57e114ee74e28cf79125d`.

Preuves locales : `/private/tmp/slopify-v2-docker-H9IcjS` (fichiers `cli.stdout`, `cli.stderr`, puis `runs/<run-id>/state.json` et `attempts/*/`).

Le plafond de cinq et les deux vagues de sept tâches ont été vérifiés dans les tests automatisés ; l’essai Docker réel couvre une vague mixte de deux tâches.

## Suivi de l’Agent Hôte

Le suivi CLI ajoute `progress`, `issues`, `nextActions` au snapshot JSON, et expose en texte les états, blocages, codes agent, diagnostics, checkpoints, rapports, traces et commandes explicites. `run` et les reprises annoncent l’identifiant et les changements sur stderr après sauvegarde durable. En mode JSON, stderr reçoit des événements `type: "progress"` et stdout conserve un seul résultat final.

Validation complémentaire : build et suite monorepo réussis, 407 tests (169 Slopify). Les tests couvrent le suivi avant la fin du run, la conservation du format stdout, les dépendances attendues, les résultats non encore intégrés, les problèmes malgré un code agent 0, les erreurs JSON, les résolutions manuelles et la distinction des diagnostics historiques. Les observations des sept tâches vérifient aussi le plafond de cinq à chaque sauvegarde et la réussite après reprise. La nouvelle consultation `tasks status` a été vérifiée sur le run Docker réel décrit ci-dessus.
