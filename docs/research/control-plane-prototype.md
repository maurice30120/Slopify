# Résultat du prototype — 19 octobre 2026

Prototype d'architecture Control Plane (Controller/Scheduler, Workers simulés) comparé au moteur V2 réel. Les sources exécutables, les diagnostics et les relevés bruts (`observed-results.json`) sont archivés sur la branche jetable `archive/control-plane-prototype`, commit `f193783`.

**L'occupation est identique dans les cas normaux étudiés ; cela ne permet pas de conclure sur l'isolation des blocages.** Le moteur V2 réel démarre déjà C après A sans attendre B. Un essai complémentaire demandé après ce premier bilan reproduit toutefois un gel global de l'admission sur conflit Git, même pour une branche indépendante. Le premier modèle comparatif ne représentait pas les conflits.

Commande exécutée avec succès : `rtk npm --prefix slopify/prototypes/control-plane start`. Les 24 combinaisons convergent et restent stables après vingt observations supplémentaires. La compilation V2 réussit.

| Scénario | Workers | Direct : durée / occupation | Réconciliation : durée / occupation | Inactivité avec travail prêt : direct / réconciliation |
| --- | ---: | --- | --- | --- |
| DAG | 1 | 15 / 100 % | 15 / 100 % | 0 / 0 |
| DAG | 2 | 10 / 75 % | 10 / 75 % | 0 / 0 |
| DAG | 3 | 10 / 50 % | 10 / 50 % | 0 / 0 |
| Revue et correction | 1 | 21 / 100 % | 21 / 100 % | 0 / 0 |
| Revue et correction | 2 | 14 / 75 % | 14 / 75 % | 0 / 0 |
| Revue et correction | 3 | 14 / 50 % | 14 / 50 % | 0 / 0 |
| Notification perdue | 2 | 19 / 55,3 % | 14 / 75 % | 11 / 0 |

Les durées et l'inactivité sont des unités virtuelles. Le scénario de réouverture JSON retrouve les résultats de revue/correction aux trois capacités ; aucune activité terminée n'est rejouée. Avec un Worker, la notification perdue nécessite un rescan direct mais ne change pas la durée totale. Avec trois, elle donne les mêmes durées qu'avec deux et une occupation de 36,8 % contre 50 %.

Avec deux Workers, dans le scénario revue/correction : A s'implémente de t=0 à 2, sa revue finit à 3 et C démarre immédiatement. C est intégrée à 7. B s'implémente de 0 à 9 ; sa revue rejette le résultat à 10, l'implémenteur reçoit les constats et corrige de 10 à 12, puis la revue accepte à 13. La validation finale finit à 14. Le refus de B ne bloque donc pas C. Un troisième Worker n'accélère pas ce graphe de largeur deux.

La référence réelle V2 vérifie :

- Lot et reprise du lot terminé : `succeeded`.
- Pic de deux exécutions simultanées ; C démarre avant la fin de B.
- C lit le contenu de A depuis sa branche intégrée avec Git réel.
- Une tentative par tâche et pour la validation finale ; aucune nouvelle exécution à la reprise.
- HEAD du dépôt hôte temporaire inchangé.

Ces vérifications ne sont pas un benchmark temporel de V2. La revue par tâche avec correction n'est appliquée qu'aux deux modèles : V2 possède actuellement une revue finale. Son ajout est une politique nouvelle, pas un gain démontré de la séparation Controller/Scheduler.

La réconciliation apporte une propriété utile dans le modèle : un résultat enregistré fait progresser le lot même si sa notification est perdue. Le flux direct attend ici sa reprise explicite. Cela illustre l'intérêt de rescanner l'état ; cela ne démontre ni un défaut réel de V2 sur ce cas, ni la nécessité de services séparés. Un rescan dans le moteur existant pourrait apporter cette propriété.

La séparation ajoute quatre intentions dans le DAG simple, neuf avec les revues/corrections. Ces nombres décrivent le prototype, pas un coût de production mesuré. Ils matérialisent l'état supplémentaire à gérer.

Un diagnostic complémentaire utilise deux groupes de trois tâches dans le même lot : A1 → B1, A2 → B2, A3 → B3, avec trois places. A2 est la seule tâche fautive. Service V2 et Git sont réels, les agents sont simulés. Commande après compilation : `rtk node --test slopify/prototypes/control-plane/blocking-diagnostic.mjs`. Elle produit volontairement un échec pour le comportement souhaité sur conflit.

| Incident en A2 | Résultat observé dans V2 |
| --- | --- |
| Échec de l'agent | A1, A3, B1 et B3 réussissent ; B2 et la revue finale restent bloquées. |
| Conflit Git après intégration de A1 | A3 et B1 terminent leur exécution mais leurs checkpoints ne sont plus intégrés ; B2 et B3 restent en attente ; le lot est `conflicted`. |

L'état de conflit appartient au lot : il ferme l'admission et l'intégrateur. Les tentatives actives peuvent finir, mais leurs descendants ne sont pas débloqués tant que leurs checkpoints ne sont pas intégrés. Le cas indépendant B3 expose donc bien un gel au-delà des descendants de A2. Les tests existants de V2 confirment que cet arrêt est explicite dans le comportement actuel. L'utilisateur a ensuite précisé que son observation concernait une tâche très longue, pas un conflit : ce diagnostic de conflit est un cas distinct, pas l'explication de son observation.

Un second diagnostic garde A2 active derrière une barrière explicite, jusqu'à l'observation de la progression du reste du lot : `rtk node --test slopify/prototypes/control-plane/slow-diagnostic.mjs`. Les six tâches ont trois places, les trois tâches A démarrent ensemble, le service et Git restent réels. Les deux variantes ne diffèrent que par leurs dépendances.

| Dépendances des tâches B | État observé pendant que A2 reste `running` |
| --- | --- |
| A1 → B1, A2 → B2, A3 → B3 | A1, A3, B1 et B3 sont `succeeded`. Seule B2 attend son prérequis A2. |
| Chaque tâche B dépend de A1, A2 et A3 | A1 et A3 sont `succeeded` ; B1, B2 et B3 restent `pending`. |

Les deux variantes passent et terminent après libération de A2. Dans cette version et cette configuration, la seule lenteur de A2 ne reproduit donc pas un gel des tâches indépendantes. Une barrière de groupe portée par le manifeste le reproduit, conformément aux dépendances déclarées. L'utilisateur précise que les dépendances de son lot portent seulement sur les prérequis individuels : il ne faut donc pas attribuer son observation à une barrière dans le manifeste sans preuve. Une réconciliation respectant de véritables dépendances de groupe attendrait elle aussi.

L'historique fournit une distinction de version essentielle : le commit `6c1f49bd8193e3efd88c75062ec8802a3ddc5e7d`, daté du 18 octobre 2026 à 09:55 (Europe/Paris), « schedule ready tasks without wave barriers », a remplacé `runWaves` par `runSchedule`. Avant ce changement, le service exécutait `await Promise.all(wave.map(...executeTask))` avant la boucle d'intégration. Une tâche lente retardait donc l'intégration de tous les résultats de sa vague et le lancement de leurs descendants, même avec des dépendances individuelles. La version actuelle intègre les résultats disponibles et réadmet du travail en continu via `Promise.race`.

Le comparatif initial évalue V2 après ce correctif, pas cette ancienne V2 par vagues. Le symptôme décrit correspond au mécanisme antérieur ; l'identifiant et la version de l'exécution observée restent nécessaires pour lui attribuer cette cause avec certitude. L'historique démontre aussi que retirer les barrières de vague a été réalisé dans le service existant, sans migration vers un Control Plane complet.

Ce diagnostic mesure une limite absente du premier comparatif. Une architecture avec Controller et Scheduler ne l'élimine pas automatiquement : garder un indicateur global de conflit et un checkout d'intégration en conflit produirait le même arrêt. Le prochain essai utile doit évaluer l'isolation d'un conflit, la remise en état de l'intégrateur et la poursuite des branches indépendantes, avec les mêmes opérations Git dans les deux variantes.

Proposition issue des essais : conserver l'ordonnancement continu et les transitions codées, puis évaluer la réconciliation et l'isolation des blocages dans V2 avant une migration complète. durable-pi, Pi RPC et Docker restent des options pour une intégration ultérieure. La conservation des conversations, les effets externes interrompus et la reprise réelle restent à éprouver.

Lot réel publié : [spec #132](https://github.com/maurice30120/Slopify/issues/132), [A #133](https://github.com/maurice30120/Slopify/issues/133), [B #134](https://github.com/maurice30120/Slopify/issues/134), [C #135](https://github.com/maurice30120/Slopify/issues/135). Les trois tickets sont ouverts et `ready-for-agent` ; C est bloqué uniquement par A. Leur simulation ne valide aucun de leurs critères fonctionnels.
