---
status: accepted
---

# Confier le lot à Slopify depuis Vibe

L’utilisateur demande à Vibe d’utiliser Slopify pour implémenter les tâches d’une spec. Vibe récupère la spec et les tickets approuvés, depuis les fichiers ou les issues auxquels il a accès, et transmet à Slopify le lot complet avec ses dépendances et ses références de source. Slopify valide le graphe, décide quand lancer chaque tâche et assure l’isolation des implémenteurs ainsi que l’intégration de leurs résultats.

Ce choix confie la lecture des sources à l’agent qui dispose de leur contexte et de leurs accès, tout en conservant les règles d’exécution dans Slopify. Vibe ne pilote pas les lancements tâche par tâche et Slopify n’a pas besoin de connecteurs de tracker pour ce parcours. Vibe, Codex et Pi sont disponibles pour l’implémentation dès la V2 ; Vibe choisit l’implémenteur par tâche et transmet ces attributions avec le lot.

Le lot est transmis dans un fichier JSON unique contenant les tâches, leurs dépendances, leurs agents et les chemins vers le contexte local figé. Ce contrat évite à Slopify de distinguer les tickets issus de fichiers de ceux issus d’un tracker. Le détail des champs, des validations et du suivi du run reste à préciser.
