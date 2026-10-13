---
status: accepted
---

# Émettre des Signaux d'activité périodiques vers l'Agent Hôte entre les transitions d'état

## Contexte

La progression d'un run ne remonte à l'Agent Hôte qu'après chaque sauvegarde durable
d'état : lancement de tâche, fin de tâche, intégration de vague. Pendant qu'un agent
travaille en sandbox — souvent plusieurs minutes — l'Agent Hôte ne reçoit rien, alors
que l'exécuteur écrit déjà en direct les traces stdout/stderr de la tentative dans le
répertoire de résultats et que le clone de la tentative est observable côté hôte.

## Décision

Pendant toutes les commandes longues (`run`, `resume`, `resume-task`,
`resolve-conflict`, `validate-resolution`), un tick minute émet un Signal d'activité :
une phrase courte par tâche active qui a du nouveau (une phrase max par tâche et par
minute), les tâches sans nouvelles regroupées en une seule phrase, et une phrase pour
les phases d'intégration de vague. La phrase est construite mécaniquement, sans LLM :
dernière ligne significative du log de la tentative (ANSI retiré, tronquée), à défaut
delta `git status` du clone de la tentative, à défaut « rien de nouveau depuis N min ».

Le signal est émis sur stderr comme événement JSON dédié (et en phrases préfixées en
mode texte) **et** persisté intégralement dans le journal du store, consultable via
`tasks status` qui affiche les dix derniers signaux du run. Les phrases ne remplacent
jamais les événements de progression : c'est un canal supplémentaire, entre deux
transitions d'état.

## Conséquences

- L'Agent Hôte reçoit un plancher d'une information par minute, même si le run
  s'exécute en appel bloquant et ne lit stderr qu'après coup : le journal persisté
  reste rattrapable par `tasks status`.
- Le rythme est déterministe et testable : tick fixe, extraction mécanique, pas de
  résumé généré. Le volume reste borné en vague pleine (une phrase par tâche active).
- Aucun changement du contrat des agents : les prompts et skills transmis restent
  intacts ; le signal exploite des sources déjà écrites par l'exécuteur.
- Le tail de log et le poll git introduisent une lecture de fichiers et une commande
  git par tâche active et par minute : coût négligeable, mais le tick doit se taire
  dès qu'aucune tâche n'est active.
