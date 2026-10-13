# Specification: Signaux d'activité pendant les commandes longues de Slopify

## Problem statement

Pendant qu'une tâche s'exécute dans un sandbox, l'Agent Hôte ne reçoit rien entre
deux transitions d'état durable (lancement, fin, intégration de vague). L'exécuteur
écrit pourtant déjà les traces stdout/stderr de la tentative dans le répertoire de
résultats, et le clone de la tentative est observable côté hôte. La décision
acceptée est l'ADR `docs/adr/0013-emit-periodic-activity-signals.md`.

## Décisions acceptées (ADR 0013)

Pendant toutes les commandes longues (`run`, `resume`, `resume-task`,
`resolve-conflict`, `validate-resolution`), un tick minute émet un Signal
d'activité :

- une phrase par tâche active qui a du nouveau (une phrase max par tâche et par
  minute) ; les tâches sans nouvelles sont regroupées en une seule phrase ;
- une phrase pour les phases d'intégration de vague ;
- construction mécanique, sans LLM : dernière ligne significative du log de la
  tentative (codes ANSI retirés, tronquée à environ 200 caractères), à défaut
  delta `git status` du clone de la tentative, à défaut « rien de nouveau depuis
  N minutes » ;
- émission sur stderr comme événement JSON dédié en mode `--json` (distinct des
  événements `progress`) et en phrases préfixées en mode texte ;
- persistance intégrale dans le journal d'activité du run dans le store ;
- `tasks status` affiche les dix derniers signaux du run ;
- le tick démarre avec l'exécution, se tait sans tâche active ni intégration, et
  s'arrête à la fin ou à l'interruption ;
- aucune panne de lecture (log ou git) n'interrompt l'exécution d'une tâche.

Aucun changement du contrat des agents : les prompts et skills transmis restent
intacts ; le signal exploite uniquement des sources déjà écrites par l'exécuteur.

## Tickets du lot

| ID | Ticket | Dépend de |
|----|--------|-----------|
| issue-59 | Heartbeat minute d'une tâche pendant `tasks run` (#59) | — |
| issue-60 | Regroupement par run et phases d'intégration (#60) | issue-59 |
| issue-61 | Fallback delta Git quand le log est silencieux (#61) | issue-59 |
| issue-62 | Rattrapage des 10 derniers signaux dans `tasks status` (#62) | issue-59 |
| issue-63 | Couvrir `resume`, `resume-task`, `resolve-conflict`, `validate-resolution` (#63) | issue-59, issue-60 |
| final-verify | Revue finale Standards/Spec du résultat intégré | les cinq tickets |

Le texte complet et les critères d'acceptation de chaque ticket appartiennent au
prompt de la tâche correspondante du lot.

## Code visé et conventions

- Orchestration des lots : `slopify/src/taskBatch.ts` (seam public
  `TaskBatchService`), CLI : `slopify/src/taskBatchCli.ts`, exécution Docker :
  `slopify/src/dockerTaskExecutor.ts`, adaptateur Pi : `slopify/src/piTaskAdapter.ts`.
- Store durable par défaut sous `~/.local/share/slopify/task-runs/` ;
  branches d'intégration `feature/slopify-<run-id>`.
- Vocabulaire : le terme « Signal d'activité » est défini dans `CONTEXT.md`.
- Tests : `node:test` sous `slopify/test/`, suite lancée par `npm test` à la
  racine du monorepo ; `npm run build` à la racine doit passer.

## Validation

- `npm run build` à la racine du monorepo sans erreur.
- `npm test` complet à la racine du monorepo sans échec, y compris les nouveaux
  tests des signaux d'activité.
- La vérification finale du lot (final-verify) bloque la réussite du run si elle
  échoue.
