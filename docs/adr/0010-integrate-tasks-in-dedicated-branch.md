---
status: accepted
---

# Intégrer les tâches dans une branche dédiée

Pour la V2, Slopify fusionne chaque tâche réussie dans une branche d’intégration dédiée ; les tâches dépendantes démarrent depuis l’état intégré courant. La branche de travail de l’utilisateur reste inchangée jusqu’à ce qu’il récupère le résultat. Ce choix permet aux descendants de travailler sur les changements déjà intégrés tout en isolant la livraison du workspace de l’utilisateur.

En cas de conflit, Slopify suspend les nouveaux lancements et conserve les résultats. Vibe reçoit les fichiers en conflit et les tâches concernées, propose une résolution puis demande à l’utilisateur d’autoriser une tentative dans un sandbox dédié. La reprise nécessite la résolution du conflit et sa validation ; la résolution entièrement automatique est hors du périmètre V2. Ce choix privilégie une décision humaine lorsque des changements peuvent exprimer des intentions incompatibles.

Les tâches déjà lancées terminent leur exécution pendant la pause ; leurs résultats sont conservés sans être fusionnés avant la résolution et la validation du conflit. Cela préserve le travail en cours tout en gardant la branche d’intégration stable pendant la résolution.

À la fin du run, Slopify retourne le nom de la branche d’intégration et le bilan des tâches. Vibe présente le résultat ; l’utilisateur décide de le récupérer dans sa branche, sans fusion automatique par Slopify.

Cette décision remplace, pour la cible V2, l’intégration différée jusqu’à la fin du DAG décrite dans [Promote one multi-agent change set](0002-promote-one-multi-agent-change-set.md). Le fonctionnement V1 reste inchangé.
