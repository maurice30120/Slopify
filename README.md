# Slopify

**Run the frontier.** Slopify transforme un plan de développement avec dépendances
en workflow multi-agent exécutable.

Les skills décrivent comment clarifier une demande, écrire une spécification et la
découper en tickets. Slopify prend ensuite le relais : il valide les dépendances,
construit un DAG, détermine les tâches prêtes à démarrer et confie chaque étape à
un agent via [ACP](https://agentclientprotocol.com/). Les agents qui écrivent du
code travaillent dans des Docker Sandboxes isolées ; leurs changements
n'atteignent le workspace hôte qu'à travers une promotion contrôlée.

> Slopify s'appuie sur les méthodes de développement publiées dans
> [`mattpocock/skills`](https://github.com/mattpocock/skills). Il fournit le
> moteur d'orchestration, d'isolation et de reprise qui permet de les exécuter
> comme un workflow reproductible.

## Pourquoi Slopify ?

Une liste de tickets indique quoi faire. Slopify exploite aussi les relations
`needs` entre ces tickets afin de calculer leur ordre d'exécution :

```text
T1 modèle ──→ T2 API ──→ T4 interface ──┐
     └──────→ T3 import ────────────────┼─→ T5 vérification
T0 migration ───────────────────────────┘
```

Les tickets sans dépendance non satisfaite forment la **frontier**. Ils peuvent
être exécutés sans attendre les branches indépendantes. L'isolation évite que
plusieurs agents se gênent pendant ce travail, tandis que les checkpoints et la
promotion conservent un résultat inspectable et maîtrisé.

Slopify apporte ainsi :

- un plan d'exécution déterministe dérivé des dépendances entre tickets ;
- l'exécution de DAG, avec préparation du parallélisme des tâches indépendantes ;
- des agents interchangeables derrière une frontière ACP ;
- des skills et artefacts figés pour rendre chaque run reprenable ;
- un sandbox privé et un Agent Checkpoint pour chaque agent qui écrit ;
- une validation humaine avant les étapes sensibles et la Promotion finale.

La compilation d'un `acp.ticket-graph/v1` en plan immuable est disponible sur la
branche de développement actuelle. Le pipeline distribué livre encore les tickets
séquentiellement ; l'exécution dynamique de toute la frontier est le prochain
palier décrit dans la [roadmap](ROADMAP.md).

## Comment fonctionne un run ?

```text
demande
  → clarification
  → spécification
  → tickets + dépendances
  → plan d'exécution immuable
  → agents ACP dans des sandboxes isolées
  → checkpoints
  → revue et Promotion
```

Le pipeline par défaut enchaîne les skills de clarification, de modélisation du
domaine, de spécification, de découpage en tickets, d'implémentation et de revue.
Le détail du calcul des dépendances, de l'isolation et de la promotion est décrit
dans [Le modèle d'exécution](docs/execution-model.md).

## Prérequis

- Node.js 22.19 ou plus récent ;
- npm ;
- [Docker Sandbox](https://docs.docker.com/ai/sandboxes/) (`sbx`) pour les agents
  isolés ;
- au moins un agent configuré et authentifié (Vibe, Codex ou OpenCode).

## Installation

Depuis le monorepo :

```bash
npm install
npm run build
npm link -w slopify
slopify --help
```

Sans installation globale :

```bash
npm run slopify -- list
npm run slopify -- run "Ajouter une commande export"
```

La documentation détaillée de la CLI couvre la configuration des agents, les
skills embarquées, la reprise et la distribution :
[`slopify/README.md`](slopify/README.md).

## Structure du monorepo

| Workspace | Responsabilité |
| --- | --- |
| `slopify` | CLI et projection terminal du runtime |
| `acp-workspace` | Configuration, catalogues et ressources figées d'un run |
| `acp-pipeline` | Validation, compilation et exécution des DAG |
| `acp-runtime` | Connexions et hôtes d'agents ACP |
| `acp-sandbox` | Docker Sandboxes, checkpoints et Promotion Git |

Cette séparation maintient le moteur de pipeline indépendant du terminal, du
fournisseur d'agent et du backend d'isolation.

## Développement

```bash
npm run build
npm test
```

Les décisions d'architecture sont conservées dans [`docs/adr`](docs/adr), et
les jalons à venir dans la [roadmap](ROADMAP.md).
