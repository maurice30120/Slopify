---
status: accepted
---

# Faire avancer les lots par des transitions codées

Ces règles sont les critères comportementaux de l'expérimentation. Le prototype doit vérifier si les organiser en Controller et Scheduler apporte un gain face au moteur V2 ; elles ne démontrent pas à elles seules la nécessité d'un Control Plane.

Pour la cible V2, le Controller fait avancer les cas prévus à partir de l'état observé et des règles explicites du lot. Il ne sollicite pas un LLM pour décider d'une transition déjà déterminée par ces règles. Ce choix rend la progression ordinaire prévisible et évite un appel modèle pour chaque changement d'état.

La fin de l'implémentation entraîne la revue ; une revue demandant des corrections entraîne le retour des constats à l'implémenteur, puis une nouvelle revue. Un résultat validé et intégré rend ses descendants admissibles à l'ordonnancement, même si une tâche indépendante reste en correction. Les preuves de revue qui autorisent l'intégration suivent l'[ADR 0014](0014-mechanize-review-adjudication.md).

Le Scheduler affecte le travail admissible aux Workers disponibles dans la limite de concurrence du lot, afin d'éviter les temps morts lorsqu'un travail indépendant peut avancer. Les intégrations restent séquentielles et suivent la disponibilité des résultats validés ; l'ordre du manifeste départage les résultats prêts simultanément. Il n'y a pas d'ordre global d'intégration figé indépendamment des durées d'exécution : C peut être intégrée pendant que B reste en correction si C ne dépend pas de B.

Pour le POC, implémentations, corrections et revues utilisent un même pool de N Workers, avec au plus N exécutions Pi simultanées tous rôles confondus. Une tâche en attente de revue libère son Worker ; son travail et son contexte restent associés à la tâche pour la suite. Un Worker peut être réaffecté à une autre activité admissible. La revue utilise une session distincte de celle de l'implémenteur, même lorsqu'un environnement est réutilisé.

Le Controller s'appuie sur [durable-pi, conformément à l'ADR 0016](0016-use-pi-durable-controller-and-pi-rpc-workers-v2.md). Dans les situations qui nécessitent un jugement supplémentaire, un agent peut analyser le problème et choisir une action autorisée : nouvelle revue, nouvelle tentative ou suspension. Les outils métier Slopify font respecter les budgets, les invariants et le périmètre du lot ; une modification des objectifs ou des dépendances demande une décision utilisateur.

Lors d'une correction après revue ou d'une relance technique, l'exécution repart du dernier état de travail de la tâche vérifié comme exploitable. Les retours de revue et la conversation Pi sont conservés lorsque cette dernière reste utilisable. Ce choix préserve le travail valide et son contexte, y compris lorsqu'un remplacement du Worker est nécessaire.

Les corrections après revue et les relances techniques consomment deux budgets distincts et bornés. Par défaut, chaque tâche dispose de deux corrections après l'implémentation initiale, soit trois tentatives d'implémentation au maximum, et de deux relances techniques cumulées sur le run. Le compteur technique est conservé entre les corrections ; les deux limites sont configurables.

Un incident technique ne consomme pas une correction du code. L'épuisement de l'un des budgets suspend la tâche avec un diagnostic et bloque ses descendants ; les tâches indépendantes peuvent continuer. Les opérations précises de redémarrage ou de remplacement restent à définir.
