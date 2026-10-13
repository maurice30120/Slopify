# Slopify — Infographies du fonctionnement constaté dans le code

Inspection du 8 octobre 2026, espace de travail au commit `d6504a4b0`.
Les README et le guide coordinateur ne servent pas de preuve aux affirmations ci-dessous.
Les images ont été produites avec l’outil intégré imagegen, puis relues en regard du code. Aucune exécution Docker n’a été effectuée : il s’agit d’une lecture statique.

## Les trois planches

1. [Rôles et délégation](01-roles-et-delegation.png) : utilisateur, hôte, CLI, agents principaux et sous-agents.
2. [Cycle et vagues](02-cycle-et-vagues.png) : entrées, contexte figé, dépendances, exécution parallèle et intégration.
3. [Suivi, reprises et conflits](03-suivi-reprises-conflits.png) : commandes, stockage et limites des contrôles.

## Comment lire la séparation des rôles

L’agent hôte représente le client conversationnel qui prépare les fichiers et appelle la CLI. Il reste extérieur au processus Slopify. La CLI ne vérifie pas l’identité du client, n’impose pas de passer par un hôte et ne réclame pas un accord humain avant chaque commande. L’utilisateur peut également l’appeler directement.

Slopify ordonnance les tâches du lot. Pour chaque tentative, il prépare un clone Git puis une sandbox Docker et y lance un agent principal Pi ou Codex. Le principal reçoit le prompt sans réécriture, plus des instructions de harness distinctes. Ces instructions demandent implémentation, TDD, commit provisoire, revues indépendantes et corrections.

Les sous-agents sont appelés par l’agent principal. Pour Pi, l’adaptateur charge l’extension officielle `subagent`, écrit deux rôles `standards` et `spec`, puis donne une instruction d’appel parallèle. Pour Codex, le harness demande les revues et l’adaptateur collecte les sessions natives et recherche certaines erreurs de collaboration. Slopify ne crée pas un autre Docker pour chaque reviewer. La demande de lecture seule des reviewers Pi est une instruction de rôle ; leur liste d’outils comprend `bash`.

Le retour fonctionnel vers Slopify comprend le rapport et le verdict de l’agent ; l’exécuteur Slopify crée ensuite le checkpoint si les contrôles de sortie passent. Les flèches de la première planche regroupent ces échanges. L’agent principal agrège les constats des reviewers avant son propre verdict.

**Ce qui est demandé à l’agent et ce que le code garantit sont distincts.** L’absence totale d’appel de revue n’ajoute pas, à elle seule, un diagnostic bloquant dans les adaptateurs inspectés. Un verdict `succeeded` reste une déclaration : la CLI ne relance pas indépendamment la suite de tests pour le confirmer.

## Vagues, Git et résultats

La limite fixe est de cinq tâches prêtes, choisies dans l’ordre du JSON. La satisfaction d’une dépendance exige le statut `succeeded`, obtenu après intégration. Toutes les tâches d’une vague partent du même commit intégré. `Promise.all` attend toute la vague ; les checkpoints disponibles sont ensuite intégrés dans l’ordre du lot.

`completed` signifie que l’agent a terminé avec un checkpoint accepté, encore à intégrer. Le statut de la tentative peut alors être `succeeded` tandis que celui de la tâche reste `completed`. Le run réussit lorsque toutes les tâches sont `succeeded`.

Le résultat est publié sous forme d’une **branche locale** `feature/slopify-<runId>` dans le dépôt hôte. Le chemin V2 ne fait pas de push distant ni de merge automatique dans la branche utilisateur. La spec et le lot sont copiés ; les modifications non commitées de l’utilisateur sont exclues. Les sandboxes intégrés sont supprimés, sauf erreur de nettoyage ; les échecs et conflits restent inspectables.

La revue finale de la planche 2 est un exemple de tâche fournie dans le lot. Aucun code du service n’en ajoute automatiquement une.

## Commandes de conflit et de reprise

Les commandes complètes correspondant aux stratégies de la planche 3 sont :

```sh
slopify tasks conflict <runId> --json
slopify tasks resolve-conflict <runId> --strategy manual --json
slopify tasks resolution <runId> --json
# Travailler et committer dans le chemin resolution.sandboxPath retourné.
slopify tasks validate-resolution <runId> <resolutionId> --json
```

Autres stratégies explicites :

```sh
slopify tasks resolve-conflict <runId> --strategy use-current --json
slopify tasks resolve-conflict <runId> --strategy use-incoming --json
```

Ajouter les mêmes `--cwd` et `--store` si le run a été créé avec ces paramètres.

- `use-current` conserve l’état intégré et marque la tâche entrante `failed` ; ses descendants peuvent donc être bloqués.
- `use-incoming` remet le checkpoint entrant à `completed` puis rappelle l’intégration. **Déduction du chemin de code :** puisque la base intégrée n’est pas remplacée directement, la même fusion peut rencontrer de nouveau le conflit.
- `manual` crée un **clone Git local**, malgré les noms de variables contenant « sandbox ». Cette branche du service n’appelle pas `sbx create` et ne prépare pas automatiquement une fusion conflictuelle. Il faut construire le résultat voulu et le committer dans ce clone.
- `validate-resolution` vérifie notamment l’ascendance depuis la base de la tâche en conflit, crée un bundle et reprend l’intégration. Cette fonction ne lance pas de tests et ne prouve pas que les deux ensembles de changements ont été correctement combinés.

`resume` réutilise les réussites et les checkpoints récupérables, puis remet les échecs, interruptions et blocages en état de reprise. `resume-task` exécute seulement la tâche sélectionnée ; il ne relance pas tout le graphe. Un état `running` est sauvegardé, sans contrôle de présence du processus : l’arrêt de l’ancien agent avant reprise reste une précondition indiquée au client.

## Références du code

| Sujet | Point d’entrée |
|---|---|
| Routage CLI V2 | [cli.ts](/Users/dhuyet/Documents/POC/Slopify/slopify/src/cli.ts:13) |
| Commandes, sorties et codes de retour | [taskBatchCli.ts](/Users/dhuyet/Documents/POC/Slopify/slopify/src/taskBatchCli.ts:28) |
| Store par dépôt, création et gel du contexte | [taskBatch.ts](/Users/dhuyet/Documents/POC/Slopify/slopify/src/taskBatch.ts:115) |
| Validation structurelle et cycles | [validateBatch](/Users/dhuyet/Documents/POC/Slopify/slopify/src/taskBatch.ts:804) |
| Ordonnancement et attente des vagues | [executeWaves](/Users/dhuyet/Documents/POC/Slopify/slopify/src/taskBatch.ts:186) |
| Tentative et clone privé | [executeTask](/Users/dhuyet/Documents/POC/Slopify/slopify/src/taskBatch.ts:275) |
| Intégration, publication et nettoyage | [integrateTask](/Users/dhuyet/Documents/POC/Slopify/slopify/src/taskBatch.ts:307) |
| Reprise globale | [resume](/Users/dhuyet/Documents/POC/Slopify/slopify/src/taskBatch.ts:383) |
| Reprise d’une tâche | [resumeTask](/Users/dhuyet/Documents/POC/Slopify/slopify/src/taskBatch.ts:440) |
| Stratégies de conflit et clone manuel | [resolveConflict](/Users/dhuyet/Documents/POC/Slopify/slopify/src/taskBatch.ts:530) |
| Validation de résolution | [validateResolution](/Users/dhuyet/Documents/POC/Slopify/slopify/src/taskBatch.ts:656) |
| Exécuteur Docker et harness | [dockerTaskExecutor.ts](/Users/dhuyet/Documents/POC/Slopify/slopify/src/dockerTaskExecutor.ts:41) |
| Adaptateur Codex et traces natives | [codexAdapter](/Users/dhuyet/Documents/POC/Slopify/slopify/src/dockerTaskExecutor.ts:137) |
| Pi, Mistral et configuration des reviewers | [piTaskAdapter.ts](/Users/dhuyet/Documents/POC/Slopify/slopify/src/piTaskAdapter.ts:8) |
| Verdict final | [agentOutcome.ts](/Users/dhuyet/Documents/POC/Slopify/slopify/src/agentOutcome.ts:4) |
| Statut, diagnostics et actions proposées | [taskBatchReport.ts](/Users/dhuyet/Documents/POC/Slopify/slopify/src/taskBatchReport.ts:17) |

Le graphe actif `cli → taskBatchCli → TaskBatchService → DockerTaskExecutor` importe directement `@acp-client/sandbox`. Les dépendances conservées dans le package et les fichiers historiques `host.ts`, `run.ts`, `runtimeBackend.ts` ne prouvent pas un passage par le moteur de pipeline ACP dans le parcours V2.

Les prompts exacts des images sont conservés dans [prompts.md](prompts.md).

