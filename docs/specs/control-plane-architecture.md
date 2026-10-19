# Architecture Control Plane inspirée de Kubernetes

## Problem Statement

Slopify exécute aujourd'hui les pipelines depuis un unique processus CLI qui compile, planifie et exécute lui-même chaque nœud. Ce modèle fonctionne pour un run local unique, mais il ne sépare pas la décision de l'exécution : impossible de reprendre un run dans un autre processus, d'ordonnancer plusieurs pipelines, d'observer l'état d'un run sans le processus qui l'a lancé, ou de réconcilier un état observé divergent sans réexécuter les nœuds déjà terminés.

L'objectif est une architecture à la Kubernetes : un Controller qui réconcilie l'état désiré avec l'état observé, un Scheduler qui crée les Sandbox Runs en respectant le DAG, des Workers qui exécutent les nœuds dans des Docker Sandboxes, et une DB qui joue le rôle d'etcd comme source de vérité unique de l'état désiré et observé.

## Solution

Introduire un Control Plane composé d'un API Server, d'un Controller et d'un Scheduler, adossé à une DB persistante. La CLI devient un client : elle soumet un pipeline (état désiré) via l'API Server, qui valide le préflight et écrit l'état désiré dans la DB. Le Scheduler observe les runs en attente et crée les Sandbox Runs pour les nœuds dont les dépendances DAG sont satisfaites. Les Workers exécutent chaque nœud dans une Docker Sandbox privée, écrivent leur statut et leurs Agent Checkpoints dans la DB, et publient leurs changements via le remote Git de la sandbox. Le Controller observe la DB, intègre les Agent Checkpoints en Pipeline Change Set dans l'ordre topologique du DAG, gère retries, reprise après crash et Integration Conflicts, puis applique la politique de Promotion (`discard`, `ask`, `auto-apply`, `auto-reject`) de façon atomique sur le workspace hôte.

Le workspace hôte reste inchangé jusqu'à la Promotion. Un crash de n'importe quel composant ne perd aucun état : la reprise réconcilie l'état observé dans la DB avec les ressources sandbox réelles (`sbx ls --json`) et suspend le pipeline en cas de divergence plutôt que de relancer ou de promouvoir implicitement.

## User Stories

1. En tant qu'utilisateur, je veux soumettre un pipeline à un Control Plane distinct de l'exécution, afin qu'un crash de la CLI ne perde pas le run.
2. En tant qu'utilisateur, je veux interroger l'état d'un run (nœuds, tentatives, checkpoints) via l'API, afin de suivre la progression sans accéder au processus qui exécute.
3. En tant qu'utilisateur, je veux que le Scheduler ne démarre un nœud que lorsque ses dépendances DAG sont terminées, afin que l'ordre d'exécution respecte le pipeline.
4. En tant qu'utilisateur, je veux que plusieurs nœuds parallèles s'exécutent dans des sandboxes distinctes, afin qu'aucun agent ne partage un workspace mutable.
5. En tant qu'utilisateur, je veux que le Controller intègre les Agent Checkpoints en Pipeline Change Set dans l'ordre topologique du DAG, puis l'ordre de déclaration, afin que le résultat soit déterministe indépendamment de l'ordre de fin.
6. En tant qu'utilisateur, je veux qu'un retry remplace uniquement le checkpoint de la tentative concernée, afin de préserver les résultats valides.
7. En tant qu'utilisateur, je veux que la DB soit l'unique source de vérité de l'état désiré et observé, afin que chaque composant soit sans état et redémarrable.
8. En tant qu'utilisateur, je veux que la reprise après crash compare le snapshot DB avec les ressources sandbox réelles, afin de ne réutiliser une sandbox que si identité et commit de base correspondent.
9. En tant qu'utilisateur, je veux qu'une divergence lors de la reprise suspende le pipeline sans suppression ni Promotion implicite, afin de diagnostiquer l'état réel.
10. En tant qu'utilisateur, je veux que le Controller boucle en réconciliation continue, afin qu'un état divergent soit corrigé sans intervention manuelle tant que les invariants tiennent.
11. En tant qu'utilisateur, je veux que la Promotion reste atomique et décidée au niveau du pipeline, afin de ne jamais obtenir un état partiellement promu.
12. En tant qu'utilisateur, je veux qu'un Integration Conflict suspende le pipeline et expose un diagnostic via l'API, afin de comprendre pourquoi la Promotion est interdite.
13. En tant qu'utilisateur, je veux que l'API Server rejette un pipeline avec effets workspace depuis un dépôt sale, absent, ou sans `sbx` compatible, afin que le préflight reste la frontière de validation.
14. En tant qu'utilisateur, je veux que le nettoyage des sandboxes reste idempotent et piloté par le Controller, afin qu'une reprise puisse le répéter sans erreur.
15. En tant qu'utilisateur, je veux que les Workers écrivent heartbeats et statuts dans la DB, afin que le Controller détecte un Worker mort et décide d'un retry.
16. En tant que mainteneur, je veux que chaque composant communique uniquement via la DB et des appels API explicites, afin d'éviter tout couplage de processus.
17. En tant que mainteneur, je veux que le Controller soit le seul composant autorisé à muter le workspace hôte, afin que la frontière de Promotion reste unique.
18. En tant que mainteneur, je veux que les concepts ACP existants (Sandbox Run, Agent Checkpoint, Pipeline Change Set, Promotion) soient conservés, afin que cette architecture étende Slopify sans le réécrire.

## Implementation Decisions

- Quatre rôles : API Server (validation, préflight, lecture/écriture d'état), Controller (réconciliation, intégration, Promotion), Scheduler (placement des Sandbox Runs), Workers (exécution des nœuds). Dans un premier livrable, tous peuvent s'exécuter dans un seul processus en modules séparés ; la séparation des rôles est le contrat, pas le déploiement.
- La DB est l'équivalent d'etcd : schéma versionné avec pipelines, runs, nœuds, tentatives, checkpoints, snapshots et heartbeats. Le moteur initial est SQLite local ; la frontière est un repository d'état, pas un ORM exposé.
- La boucle de réconciliation du Controller suit le pattern observe-compare-act : lire l'état désiré et observé dans la DB, calculer l'écart, agir (créer tentative, intégrer checkpoint, retry, suspendre), réécrire l'état observé. Aucune action sans écriture d'état d'abord.
- Le Scheduler observe les nœuds en attente dont les dépendances sont satisaites dans le snapshot, vérifie la capacité (concurrency du pipeline), puis crée les Sandbox Runs avec `sbx --clone`. Les noms de sandbox restent stables : dérivés du run, du nœud et de la tentative.
- Les Workers sont sans état : ils reçoivent un Sandbox Run, exécutent le nœud, écrivent statut/checkpoint dans la DB et publient via le remote Git. Heartbeat avec TTL pour la détection de mort.
- La CLI conserve les commandes `slopify run`, `list` et `--keep-sandboxes` ; elle devient un client de l'API Server. `slopify run` reste synchrone par défaut (affiche les événements en direct) mais survit à un redémarrage de la CLI grâce à la DB.
- Le préflight actuel (Git propre, `sbx` version et capacités, politique réseau) est déplacé dans l'API Server et s'applique à la soumission.
- Les politiques de Promotion et les snapshots existants sont réutilisés tels quels ; la DB les persiste au lieu de fichiers de snapshot isolés.
- La reprise remplace la logique de snapshot actuelle : le Controller compare l'état DB avec `sbx ls --json` et les remotes Git, puis suspend en cas de divergence.
- Aucune mutation du workspace hôte hors du Controller, et uniquement via une Promotion du Pipeline Change Set complet.

## Testing Decisions

- Le seam principal reste la CLI de bout en bout avec un faux exécuteur `sbx` ; la DB est un SQLite temporaire par test.
- Les tests de réconciliation couvrent : nœud terminé non réexécuté, nœud perdu réessayé, checkpoint intégré une seule fois, état suspendu stable entre deux itérations de boucle.
- Les tests du Scheduler couvrent : dépendances non satisfaites, DAG parallèle complet, limite de concurrence, sandbox créée uniquement à l'ordonnancement.
- Les tests de Worker couvrent : heartbeat, timeout, annulation propagée, checkpoint attribué au run/nœud/tentative.
- Les tests de reprise couvrent : crash du Controller, du Scheduler, d'un Worker, et divergence entre DB et ressources sandbox réelles.
- Les tests existants de Promotion, de checkpoints et d'exécution V3 constituent le prior art ; ils doivent passer sans modification de leurs invariants.
- Un smoke test opt-in conserve le parcours réel `sbx` : soumission API, scheduling, exécution, intégration, aperçu sans mutation hôte, Promotion, nettoyage.

## Out of Scope

- Déploiement multi-machine, Haute disponibilité du Control Plane, ou DB distribuée.
- API réseau publique : l'API Server reste locale à la machine dans cette version.
- Authentification, multi-tenant ou quotas par utilisateur.
- Résolution automatique des Integration Conflicts.
- Ordonnancement multi-sandbox par nœud ou migration de Workers.
- Changement des politiques de Promotion et de la sémantique des checkpoints.

## Further Notes

- Les ADR 0002 (Pipeline Change Set unique) et 0004 (Promotion comme politique de pipeline) restent les décisions structurantes ; cette spécification ajoute la séparation Control Plane / Workers sans les modifier.
- Le rapprochement Kubernetes est conceptuel : API Server ≈ kube-apiserver, DB ≈ etcd, Controller ≈ kube-controller-manager, Scheduler ≈ kube-scheduler, Sandbox Runs ≈ Pods. Slopify reste un outil local mono-machine.
- L'implémentation peut démarrer par l'extraction du repository d'état DB et de la boucle de réconciliation dans le processus CLI actuel, puis séparer les processus si un besoin réel apparaît.
