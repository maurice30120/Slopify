# Sources des infographies Slopify

Ces trois PNG sont intégrés au [README principal](../../../README.md) par des
chemins relatifs au dépôt, compatibles avec l’affichage GitHub. Leur contenu est
fondé sur une inspection statique du code présent dans l’espace de travail le
8 octobre 2026, avec un plafond d’exécution de **10 tâches par vague**.

## Références

| Planche | Sources du code |
|---|---|
| [01 — Rôles et délégation](01-roles-et-delegation.png) | [CLI](../../../slopify/src/cli.ts), [service de lots](../../../slopify/src/taskBatch.ts), [exécuteur Docker et Codex](../../../slopify/src/dockerTaskExecutor.ts), [adaptateur Pi et reviewers](../../../slopify/src/piTaskAdapter.ts) |
| [02 — Cycle et vagues](02-cycle-et-vagues.png) | [ordonnancement et intégration](../../../slopify/src/taskBatch.ts), [checkpoints](../../../slopify/src/dockerTaskExecutor.ts), [verdict de l’agent](../../../slopify/src/agentOutcome.ts) |
| [03 — Suivi, reprises et conflits](03-suivi-reprises-conflits.png) | [commandes](../../../slopify/src/taskBatchCli.ts), [statut et actions proposées](../../../slopify/src/taskBatchReport.ts), [reprises et résolutions](../../../slopify/src/taskBatch.ts) |

## Précisions de lecture

- L’agent hôte est un client conversationnel extérieur à la CLI. L’utilisateur
  peut également appeler directement les commandes Slopify.
- Les deux tâches dessinées dans les exemples n’illustrent pas le plafond. Le
  service sélectionne les dix premières tâches prêtes dans l’ordre du JSON et
  attend toute la vague avant d’intégrer ses checkpoints.
- L’agent principal appelle ses reviewers. Pour Pi, le code configure les rôles
  `standards` et `spec` et demande leur appel parallèle via l’extension `subagent`.
  Pour Codex, il demande les revues et collecte les traces de collaboration native.
  Le code ne crée pas de sandbox Docker distincte pour chaque reviewer.
- Les consignes de tests, de revue et de correction restent des consignes données
  à l’agent. La CLI contrôle le verdict et les erreurs observées ; elle ne garantit
  pas à elle seule que toutes les validations ou délégations ont eu lieu.
- `completed` correspond à un checkpoint disponible ; `succeeded` à une tâche
  intégrée. La revue finale est une tâche ordinaire fournie dans le lot, sans
  ajout automatique par la CLI.
- La résolution `manual` crée un clone Git local, sans appel à `sbx create` dans
  ce chemin. Il faut construire et committer le résultat attendu. Sa validation
  vérifie l’ascendance Git, sans exécuter de tests ni contrôler sémantiquement la
  combinaison des changements.
- `use-current` marque la tâche entrante `failed`. `use-incoming` retente son
  intégration ; la possibilité de retrouver le conflit est déduite de ce chemin
  de code, sans essai Docker effectué pour ces illustrations.
- Le plafond de l’ordonnanceur est bien `WAVE_SIZE = 10`. Lors de l’inspection,
  `taskBatchReport.ts` conserve encore un seuil de cinq dans le filtre des
  suggestions `resume-task` ; cette différence concerne les actions proposées,
  pas la capacité d’exécution du service.

Les images ont été harmonisées avec l’outil intégré imagegen. Les
[prompts exacts](prompts.md) sont conservés pour les prochaines mises à jour.
