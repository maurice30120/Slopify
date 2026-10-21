# ADR 0015 — Slopify V2 : modes sandbox/local et packages fonctionnels

- Date : 2026-10-20
- Statut : **proposée — validation conditionnée à #160, #161 et #163**
- Références : spécification [#138](https://github.com/maurice30120/Slopify/issues/138), correctifs [#155](https://github.com/maurice30120/Slopify/issues/155), tickets #139–#149 et #156–#163.

## Contexte

La première V2 exécute Pi et Codex exclusivement avec Docker Sandboxes. Des bibliothèques historiques ACP/V1 se trouvent dans le monorepo et le moteur de lots contient des responsabilités d'orchestration, Git et exécution.

Le produit doit aussi fonctionner sans Docker sur la machine du développeur, sur macOS ou Linux, tout en réutilisant ses comptes, modèles et outils Pi/Codex configurés localement. La structure doit refléter les responsabilités fonctionnelles et ne plus dépendre des packages V1.

## Décision

1. **Deux modes par lot** : `sandbox` (par défaut) utilise Docker Sandboxes et sa politique de ressources. `local` utilise les programmes Pi/Codex natifs de l'hôte, sans appel Docker ni `sbx`. Un run est intégralement dans un seul mode.
2. **Priorité des choix** : `--mode` au lancement, puis `.slopify/runtime.yaml`, puis `sandbox`. Le mode est persisté et ne change pas à la reprise. Les snapshots V2 sans mode signifient `sandbox`.
3. **Isolation de travail Git** : chaque tentative utilise un clone temporaire privé et une base de commit épinglée, même en mode local. Les modifications et la branche active de l'utilisateur ne sont pas touchées. Conserver **une branche d'intégration dédiée par run**, conformément à l'ADR 0010.
4. **Limite de concurrence** : le Scheduler admet au maximum dix tâches actives suivant les dépendances et l'ordre JSON. Les Workers du pool sont une notion du mode sandbox ; la capacité locale n'est pas un pool Docker.
5. **Frontières cibles** : `apps/cli` compose les adaptateurs, `@slopify/task-batches` orchestre via contrats injectés, `@slopify/git` possède les opérations Git, `@slopify/execution` les contrats de processus ; `execution-local` et `execution-sandbox` possèdent leurs spécificités ; `agent-pi` et `agent-codex` possèdent leurs protocoles et `activity` le journal. `project-init` possède les templates et ressources d'initialisation. Les packages internes ne sont pas publiés individuellement.
6. **Reprise sûre** : persister l'identité et le groupe des agents locaux au spawn. Avant `resume` ou `resume-task`, vérifier que l'agent précédent et tous ses descendants sont arrêtés ; en cas d'incertitude, refuser plutôt que créer un doublon. Une disparition forcée par SIGKILL ne déclenche aucun handler.
7. **Preuves** : checkpoints, bundles, logs et décisions opérateur demeurent inspectables, y compris après arrêt ou conflit. Les checkpoints durables réussis sont réintégrés sans rejouer l'agent.
8. **Validation** : CI = Git temporaire réel et faux exécutables sans Docker ni jetons fournisseur. Smokes avec vrais Pi/Codex : commandes manuelles `npm run smoke:local` et `npm run smoke:docker` **sur le poste de développement uniquement**.

## Conséquences

- La V2 n'a plus de compatibilité de commandes, transports ou packages ACP/V1.
- Le mode local donne aux agents les permissions ordinaires de l'utilisateur, **sans isolation supplémentaire de fichiers ou du réseau** ; il faut l'indiquer clairement.
- La surveillance de processus est dépendante du système hôte. Une identité manquante, un état `unknown` ou un groupe descendant encore actif interdit la reprise optimiste.
- Un processus déjà orphelin/zombie adopté par un PID 1 qui ne le récole pas ne peut pas être « reaped » par Slopify ; les tests doivent limiter les créations et gérer leurs enfants.
- Aucun changement du protocole de revues, des décisions de conflit ou du format durable n'est autorisé sans amendement distinct.

## Décisions remplacées

Pour le parcours V2 actif, cet ADR remplace les choix préalables limitant obligatoirement l'exécution à Docker Sandboxes/ACP. Les ADR historiques demeurent disponibles comme **archives**, pas comme sources décrivant la V2 actuelle. Les décisions d'intégration Git en branche dédiée de l'ADR 0010 restent applicables.

## Validation et limites

La décision est **conditionnelle** jusqu'à la validation effective des tickets d'architecture #160/#161 et de recette #163. Une CI Linux verte ne démontre pas le comportement réel sur Mac ni les appels aux fournisseurs. Consigner ces limites explicitement ; ne pas marquer cette ADR « acceptée » avant la recette.
