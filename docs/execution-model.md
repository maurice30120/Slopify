# Modèle d'exécution

Slopify transforme les dépendances d'un plan de développement en ordre
d'exécution. Son objectif est d'exécuter la **frontier** : l'ensemble des tâches
dont tous les prérequis sont terminés.

## De la méthode au DAG

Les skills issues de [`mattpocock/skills`](https://github.com/mattpocock/skills)
fournissent la méthode de travail. En particulier, `to-tickets` découpe une
spécification en vertical slices et associe à chaque ticket ses blocking edges.
Slopify convertit cette sortie en artefact `acp.ticket-graph/v1`.

Chaque ticket du graphe possède :

- un identifiant stable ;
- un titre et un périmètre ;
- une liste `needs` contenant ses dépendances ;
- des critères de validation ;
- éventuellement un agent conseillé.

Le compilateur refuse les identifiants dupliqués, les dépendances inconnues et
les cycles. Il produit ensuite un `acp.execution-plan/v1` immuable. Une révision
du plan ne peut être développée qu'une fois : une nouvelle découverte exige une
nouvelle version plutôt qu'une mutation silencieuse du run.

## Calcul de la frontier

Pour un ensemble de tickets `pending`, une tâche est prête lorsque toutes les
tâches listées dans `needs` sont terminées :

```text
ready(ticket) = ticket.pending
                et chaque dependency(ticket).status = completed
```

Exemple :

```text
A ──→ C ──┐
B ────────┼──→ E
D ────────┘
```

La première frontier contient `A`, `B` et `D`. `C` devient prêt lorsque `A` est
terminé. `E` attend `B`, `C` et `D`. L'ordre topologique donne donc les
contraintes, sans imposer un ordre artificiel entre les branches indépendantes.

Le runtime sait exécuter des nœuds DAG prêts en parallèle. L'expansion dynamique
du Ticket Graph vers toute sa frontier est en cours d'intégration dans le
pipeline distribué ; celui-ci conserve actuellement une livraison séquentielle
des tickets.

## Isolation des branches de travail

Le parallélisme serait fragile si plusieurs agents modifiaient le même répertoire.
Un agent autorisé à écrire reçoit donc un **Sandbox Run** : un clone privé du
dépôt exécuté par Docker Sandbox.

À la fin de son tour, l'agent produit un **Agent Checkpoint** versionné et lié au
pipeline, au nœud et à la tentative. Le checkpoint matérialise une proposition de
changement ; il ne modifie pas encore le workspace de l'utilisateur.

Cette séparation permet :

- d'exécuter des branches indépendantes sans état intermédiaire partagé ;
- de reprendre un run avec les mêmes ressources et la même provenance ;
- d'attribuer chaque changement à son nœud producteur ;
- de détecter les conflits pendant l'intégration ;
- de vérifier le résultat combiné avant qu'il atteigne le workspace hôte.

## Checkpoint, reprise et tentative

Ces opérations ont des sens distincts :

| Opération | Effet |
| --- | --- |
| Reprise | Continue un tour interrompu depuis son checkpoint, sans relancer l'agent |
| Réparation | Relance l'agent dans la même sandbox après une erreur de protocole |
| Nouvelle tentative | Crée un nouveau Sandbox Run et incrémente le numéro de tentative |

Les pipelines, instructions et dossiers complets des skills sont figés au début
du run. Une reprise relit ces ressources plutôt que la version courante du
projet, ce qui évite qu'une mise à jour change implicitement le comportement
d'une exécution déjà commencée.

## De plusieurs checkpoints à une Promotion

Les checkpoints retenus doivent former un **Pipeline Change Set** cohérent. Un
conflit d'intégration suspend le pipeline et bloque toute application partielle.

La **Promotion** est la décision explicite de transférer ce Change Set vers le
workspace hôte. Selon la politique du pipeline, Slopify peut présenter le
résultat, le rejeter ou demander une confirmation. L'option CLI `--yes` approuve
les pauses ordinaires, jamais une Promotion.

La frontière de responsabilité reste ainsi nette :

```text
skills → plan → frontier → agents isolés → checkpoints → validation → Promotion
```

Les skills définissent la méthode, le DAG expose le parallélisme possible, les
sandboxes rendent ce parallélisme sûr, et la Promotion reste l'unique passage
vers le workspace réel.
