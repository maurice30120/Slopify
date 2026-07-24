# @acp-client/runtime

Runtime Node utilisé par la CLI `slopify`.

Il porte les responsabilités indépendantes de l'hôte :

- lecture du catalogue `.acp/acp-agents.json` et `.acp/.sandcastle/config.json` ;
- lancement et connexion aux processus ACP ;
- authentification, permissions, fichiers et terminaux ACP ;
- exécution éphémère d'un agent pour un nœud de pipeline ;
- sélection du transport ACP natif ou du bridge fourni par `@acp-client/sandcastle` ;
- chargement des pipelines et des skills.

Les hôtes injectent uniquement leur UI via `RuntimePermissionContext` et la décision de promotion Sandcastle.
