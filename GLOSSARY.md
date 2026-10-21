# Slopify — langage de l'orchestration

Termes métier utilisés pour décrire le pivot Pi RPC et la conduite des lots de tâches.

## Langage

**Lot de tâches (run)** :
Ensemble identifié de tickets liés par des dépendances, lancé et suivi comme une même unité de travail.
_À éviter_ : session Pi, conteneur

**Tentative de tâche** :
Exécution identifiée d'un ticket au sein d'un lot. Un même ticket peut avoir plusieurs tentatives successives, avec leurs résultats et preuves propres.
_À éviter_ : ticket, run

**Image de développement** :
Environnement de travail désigné par le projet, contenant les outils nécessaires pour compiler, tester et modifier son code.
_À éviter_ : image Pi, image d'exécution assemblée

**Image d'exécution assemblée** :
Environnement de tâche résultant de la combinaison des outils du projet et de l'agent Pi, sans modification de l'image de développement d'origine.
_À éviter_ : image de développement, image Pi

**Sous-agent Pi** :
Agent délégué par un agent Pi principal pour une mission ponctuelle d'exploration, d'implémentation ou de revue ; distinct d'un ticket ordonnancé par Slopify.
_À éviter_ : worker Slopify, ticket

**Revue obligatoire** :
Contrôle demandé comme condition de réussite d'une tâche ou d'un lot, dont le résultat doit être connu et vérifiable.
_À éviter_ : revue facultative, simple absence d'erreur
