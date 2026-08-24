# @acp-client/runtime

Runtime Node utilisé par la CLI `slopify`.

Il porte les responsabilités ACP indépendantes de l'hôte :

- lancement et connexion aux processus ACP ;
- authentification, permissions, fichiers et terminaux ACP ;
- exécution éphémère d'un agent pour un nœud de pipeline ;
- propagation des annulations et timeouts.

La lecture des catalogues et le runtime Docker Sandbox appartiennent à
`@acp-client/workspace` et `@acp-client/sandbox`.
