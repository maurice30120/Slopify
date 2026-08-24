# Slopify

Slopify exécute des agents dans des environnements isolés et contrôle explicitement le transfert de leurs changements vers le workspace de l’utilisateur.

## Language

**Sandbox Run**:
Exécution isolée d’un agent sur une copie privée du dépôt, sans mutation du workspace hôte.
_Avoid_: container run

**Agent Checkpoint**:
Résultat versionné produit par un agent et identifié par le pipeline, le nœud et la tentative qui l’ont créé.
_Avoid_: Final promotion, agent workspace

**Pipeline Change Set**:
Résultat cohérent obtenu après intégration de tous les Agent Checkpoints retenus pour un pipeline.
_Avoid_: Agent checkpoint, partial promotion

**Ticket Graph**:
Description structurée des tâches créées et de leurs dépendances. Il constitue la source d’autorité pour préparer leur exécution ; les documents Markdown n’en sont qu’une représentation destinée aux humains.
_Avoid_: Liste de fichiers, ordre des noms de fichiers

**Execution Plan**:
Graphe validé des nœuds dynamiques injectés dans un Sandbox Run principal à partir d’un Ticket Graph. Il devient immuable avant la première implementation et détermine quels nœuds peuvent s’exécuter en parallèle tout en produisant un unique Pipeline Change Set.
_Avoid_: Boucle séquentielle, ensemble de pipelines indépendants

**Integration Conflict**:
Incompatibilité entre plusieurs Agent Checkpoints qui empêche de construire automatiquement un Pipeline Change Set cohérent. Elle suspend le pipeline et interdit toute promotion tant qu’elle n’est pas résolue.
_Avoid_: Agent failure, partial merge

**Promotion**:
Décision explicite de transférer atomiquement un Pipeline Change Set dans le workspace hôte.
_Avoid_: Apply, merge automatique

**Rejection**:
Décision explicite d’abandonner les changements d’un Sandbox Run sans modifier le workspace hôte.
_Avoid_: Cancellation, cleanup

**Cancellation**:
Fin d’un Sandbox Run sans décision explicite de promotion ou de rejet ; ses changements ne sont pas transférés.
_Avoid_: Rejection
