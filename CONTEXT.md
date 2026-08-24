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
