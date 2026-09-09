# Slopify

Slopify exécute des agents dans des environnements isolés et contrôle explicitement le transfert de leurs changements vers le workspace de l’utilisateur.

## Language

**Skill embarquée**:
Méthode réutilisable sélectionnée et fournie avec Slopify pour ses pipelines, avec les ressources et les autres skills dont elle dépend. Une skill homonyme du projet ne la remplace pas implicitement.
_Avoid_: Skill personnelle, skill du projet

**Sandbox Run**:
Exécution isolée d’un agent sur une copie privée du dépôt, sans mutation du workspace hôte.
_Avoid_: container run

**Agent Checkpoint**:
Résultat versionné produit par un agent et identifié par le pipeline, le nœud et la tentative qui l’ont créé.
_Avoid_: Final promotion, agent workspace

**Reprise**:
Reprise d’un tour interrompu en réutilisant l’Agent Checkpoint persisté, sans relancer l’agent.
_Avoid_: Réparation, relance

**Réparation**:
Nouveau tour déclenché par une erreur de protocole après un tour déjà checkpointé ; il relance l’agent dans la même sandbox et remplace l’Agent Checkpoint du même pipeline, nœud et tentative.
_Avoid_: Reprise, nouvelle tentative

**Nouvelle tentative**:
Nouvelle exécution d’un nœud qui incrémente le numéro de tentative et démarre un nouveau Sandbox Run, produisant un Agent Checkpoint distinct.
_Avoid_: Réparation, reprise

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
