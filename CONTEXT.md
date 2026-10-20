# Slopify

Slopify exécute des agents dans des environnements isolés et contrôle explicitement le transfert de leurs changements vers le workspace de l’utilisateur.

## Language

### V2 — vocabulaire confirmé pendant la conception

**Agent Hôte**:
CLI interactive depuis laquelle l'utilisateur pilote Slopify : choisir un pipeline, lancer, suivre et reprendre les runs. Distinct des agents qui exécutent les nœuds d'un pipeline.
_Avoid_: agent, coordinateur, agent de pipeline

**Controller**:
Rôle responsable de la progression des lots de tâches, de leur lancement à l’intégration de leurs résultats. Il coordonne les revues et le retour des corrections demandées aux implémenteurs.
_Avoid_: simple ordonnanceur, reviewer, implémenteur

**Scheduler**:
Rôle qui affecte le travail admissible aux Workers d’exécution disponibles, selon les dépendances et la capacité du lot.
_Avoid_: Controller, autoscaler

**Tâche d’implémentation**:
Travail de développement défini pendant la préparation, accompagné des dépendances qui conditionnent son démarrage.
_Avoid_: étape de clarification, étape de planification, nœud de pipeline générique

**Worker d’exécution** (mode sandbox uniquement):
Environnement isolé réutilisable qui prend en charge au plus une activité d’implémentation, de correction ou de revue à la fois. Son état est contrôlé et nettoyé entre les activités ; un état douteux entraîne son remplacement.
_Avoid_: slot de concurrence, environnement partagé

**Contexte de tâche**:
Ensemble du travail vérifié comme exploitable, des retours de revue et de l’historique nécessaires pour poursuivre une tâche. Il reste associé à la tâche lorsque son Worker est réaffecté ou remplacé.
_Avoid_: état du Worker, slot de concurrence

**Signal d’activité**:
Phrase courte émise périodiquement pendant un run pour informer l’Agent Hôte de l’action en cours, entre deux transitions d’état durable.
_Avoid_: heartbeat, progress, log, pulse de vie

**Revue indépendante**:
Évaluation d’une tentative par un agent distinct de celui qui a produit le travail.
_Avoid_: auto-revue, revue par l’agent d’implémentation, revue interne

**Correction après revue**:
Intervention sur le résultat d’une tâche pour répondre aux constats d’une Revue indépendante, suivie d’une nouvelle revue.
_Avoid_: relance technique, nouvelle tâche

**Relance technique**:
Rétablissement de l’exécution d’une tâche après un incident de processus ou d’environnement, en conservant le travail vérifié comme exploitable.
_Avoid_: correction après revue, recommencer à zéro

**Mode local (V2)** :
Exécution de Pi ou Codex sur la machine hôte dans un clone Git privé, sans Docker et avec la configuration native de l'agent.
_Avoid_: sandbox Docker, Worker Docker

**Mode sandbox (V2)** :
Exécution Pi ou Codex dans Docker Sandboxes ; c'est le mode par défaut d'un nouveau run.
_Avoid_: moteur ACP historique

**Capacité locale** :
Nombre maximal de tâches actives simultanées, sans impliciter un pool de Workers Docker.
_Avoid_: Worker Docker en mode local

### V1 — vocabulaire historique (archive, non actif en V2)

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
Fin d’un Sandbox Run ou d’une tentative sans décision explicite de promotion ou de rejet ; ses changements ne sont pas transférés et l’exécution demeure reprendable.
_Avoid_: Rejection, interrupted
