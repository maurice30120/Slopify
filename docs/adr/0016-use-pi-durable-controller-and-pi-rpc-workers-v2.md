---
status: proposed
---

# Évaluer un Control Plane pour Slopify V2

La question du prototype est l'utilité d'une architecture inspirée de Kubernetes pour Slopify : un état central et une boucle de réconciliation simplifient-ils réellement le pilotage, la reprise et l'occupation des Workers, par rapport au moteur V2 existant ? Le premier livrable est un petit moteur de réconciliation exécutable avec Workers simulés. Le câblage Pi/Docker, la généralisation et le durcissement viennent après cette évaluation.

Le parallélisme, le DAG et la reprise de checkpoints existent déjà en V2. Ils constituent des références de comparaison, pas des bénéfices acquis de la nouvelle architecture. Les variantes doivent recevoir les mêmes scénarios et la même capacité ; on mesure notamment les créneaux laissés libres malgré un travail admissible. Le nombre de règles et de mécanismes supplémentaires fait aussi partie du bilan.

Le [premier essai exécutable](../research/control-plane-prototype.md) confirme le démarrage de C avant la fin de B dans V2. Les modèles comparatifs n'obtiennent aucun gain d'occupation en fonctionnement normal. Un diagnostic complémentaire reproduit le gel de branches indépendantes après un conflit Git dans V2 ; les premiers modèles ne couvraient pas ce cas. La récupération d'une notification perdue illustre l'intérêt d'un rescan de l'état, sans démontrer la nécessité de séparer Controller et Scheduler en services. L'isolation des conflits reste à comparer et l'adoption du Control Plane reste ouverte.

Le candidat Control Plane cible Slopify V2. Pour une éventuelle intégration réelle après le prototype, les choix retenus sont [disler/durable-pi](https://github.com/disler/durable-pi) pour héberger le Controller et Pi, piloté par son [protocole RPC](https://pi.dev/docs/latest/rpc), pour les Workers. Ces choix ne préjugent pas de l'adoption du Control Plane ; la séparation des rôles doit démontrer son utilité avant une séparation en services.

La conservation de l'état et la reprise du Controller s'appuient sur les capacités de durable-pi, dont le backend héberge les agents et leurs bases SQLite indépendamment des clients. Leur réimplémentation dans Slopify n'est pas un objectif de cette évolution.

Pour ce candidat, le périmètre Pi uniquement restreindrait l'[ADR 0011](0011-replace-vibe-with-pi-codex-for-v2.md), qui autorisait Pi et Codex comme implémenteurs. Cette restriction n'est pas encore appliquée à la V2 existante. Le choix de runtime ne détermine pas les modèles ou fournisseurs utilisables dans Pi.

L'intégration des résultats suit l'[ADR 0010](0010-integrate-tasks-in-dedicated-branch.md) : les tâches réussies alimentent progressivement une branche d'intégration dédiée, puis l'utilisateur décide de récupérer le résultat. Les transitions ordinaires du Controller sont codées, conformément à l'[ADR 0017](0017-code-the-controllers-routine-transitions.md). Le choix du runtime ne suffit pas à définir les garanties de reprise des effets Git ou RPC.
