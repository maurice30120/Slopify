# Spec : tests unitaires dédiés pour les modules CLI non couverts

## Problem Statement

Les modules du cœur d'exécution de la CLI Slopify V2 qui interprètent le
verdict de l'agent (`agentOutcome`), préparent l'agent Pi (`piTaskAdapter`),
pilotent le cycle de vie de la sandbox (`dockerTaskExecutor`) et routent les
commandes de la CLI (`cli`) n'ont pas de tests unitaires dédiés. Ces modules
ne sont couverts qu'indirectement, voire pas du tout : une régression sur le
parsing de `SLOPIFY_RESULT`, la validation du kit Pi, la sélection
d'adaptateur ou le routage des commandes retirées n'est détectée qu'en fin de
chaîne, dans des tests d'intégration coûteux qui n'isolent pas la cause.

## Solution

Ajouter une suite de tests unitaires dédiés pour chacun de ces quatre modules,
à leurs seams publics existants, sans modifier le comportement des sources.
Chaque module obtient son fichier de test dans l'espace de test existant, au
style des tests actuels (node:test + assert/strict), avec des doublures
(stubs) pour les frontières subprocess et contexte. La suite complète reste
verte via la commande de test existante.

## User Stories

1. En tant que mainteneur de Slopify, je veux des tests unitaires pour
   l'interprétation du verdict `SLOPIFY_RESULT`, afin de détecter
   immédiatement une régression du contrat de sortie de l'agent.
2. En tant que mainteneur de Slopify, je veux qu'un message final sans
   verdict, avec deux verdicts, avec un JSON invalide ou avec un statut
   inconnu produise le diagnostic attendu, afin que les échecs d'agent soient
   classés précisément.
3. En tant que mainteneur de Slopify, je veux des tests pour la préparation
   du kit Pi (spec du sandbox, validation, montages), afin de garantir que
   l'agent Pi reçoive toujours un environnement conforme.
4. En tant que mainteneur de Slopify, je veux des tests pour les vérifications
   de disponibilité de l'agent Pi (skills en lecture seule, extension subagent,
   version), afin qu'une sandbox non prête soit refusée avec le bon diagnostic.
5. En tant que mainteneur de Slopify, je veux des tests pour le cycle de vie
   de la tâche Docker (création des fichiers d'évidence, sélection
   d'adaptateur, agent inconnu), afin que l'exécution et l'inspection des
   échecs restent fiables.
6. En tant que mainteneur de Slopify, je veux des tests pour le routage de la
   CLI (aide, commandes `tasks` et `init`, commandes retirées, commande
   inconnue), afin que le contrat d'interface documenté soit vérifié.
7. En tant que développeur agent, je veux lancer ces tâches en parallèle sur
   des modules disjoints, afin que la vague n'ait aucun conflit d'intégration.
8. En tant que mainteneur de Slopify, je veux une revue finale Standards/Spec
   du résultat combiné, afin de valider que les tests ajoutés respectent les
   standards du repo et la présente spécification.

## Implementation Decisions

- Quatre modules cibles, un fichier de test par module ; aucun nouveau
  module, aucune modification du code de production.
- Les tests utilisent uniquement les seams publics existants : la fonction
  d'interprétation du verdict d'agent, l'adaptateur de tâche Pi, l'exécuteur
  de tâche Docker et le point d'entrée de la CLI.
- Les frontières externes (sous-processus `sbx`, système de fichiers imposé,
  contexte d'agent) sont doublées par des stubs injectés par les options
  existantes ; aucun double n'est introduit dans le code de production.
- Les tests de l'interprétation du verdict restent purs : chaînes en entrée,
  liste de diagnostics en sortie.
- Les tests de l'adaptateur Pi stubbent le contexte de commande fourni par
  l'exécuteur ; les tests de l'exécuteur stubbent l'exécuteur de sous-processus.
- Les tests de la CLI vérifient les codes de sortie et les messages pour les
  entrées d'aide, de routage, de commandes retirées et inconnues.
- Style des tests existants conservé : node:test, assert/strict, un
  fichier de test par module dans l'espace de test existant du paquet CLI.
- Aucune nouvelle dépendance ; les tests s'exécutent via la commande de test
  existante du paquet, qui compile puis exécute la suite sur le code compilé.

## Testing Decisions

- Un bon test ici ne teste que le comportement observable au seam public :
  diagnostics renvoyés, codes de sortie, contenus des fichiers d'évidence,
  arguments transmis au sous-processus — jamais les détails d'implémentation.
- Modules testés : interprétation du verdict d'agent, adaptateur de tâche Pi,
  exécuteur de tâche Docker, routage de la CLI.
- Antécédents dans le dépôt : les tests de la couche d'exécution par
  exécuteur stubbé (service de lots avec sous-processus doublé), les tests du
  backend d'exécution, et les tests du flux d'exécution Pi servent de
  référence de style et de grain.
- Critère de succès de chaque ticket : la suite complète du paquet passe
  après ajout du fichier de test, sans modification des sources.

## Out of Scope

- Toute modification du comportement ou des interfaces des modules testés.
- Tests d'intégration nécessitant Docker, `sbx` ou des identifiants d'agent.
- Mesure de couverture ou seuils de couverture.
- Les autres paquets du monorepo (bibliothèques acp-*).

## Further Notes

Ce lot sert également d'essai réel de la CLI Slopify V2 : quatre tâches
indépendantes forment la première vague (plafond de cinq), la revue finale
Standards/Spec attend l'intégration de toutes les réussites. Tous les agents
sont Pi. Les échecs éventuels sont des résultats d'essai informatifs et ne
déclenchent aucune relance automatique.
