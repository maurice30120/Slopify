# Slopify V2

Slopify reçoit une spec et un lot JSON préparés dans une conversation externe,
puis exécute les tâches avec Pi ou Codex dans des sandboxes Docker distincts.
Les cinq premières tâches prêtes dans l’ordre du JSON forment une vague.
Toutes partent du même commit intégré. Slopify attend leur fin, intègre les
réussites dans l’ordre du JSON, puis calcule la vague suivante.

## Installation

Prérequis : Node.js >= 22.19, npm, Docker Sandboxes (`sbx`) et agents configurés.
Les skills `implement`, `tdd` et `code-review` doivent être disponibles dans le
magasin de skills de `sbx` et montées en lecture seule.

```bash
npm ci
npm run build
npm link -w slopify
slopify --help
slopify init --host all --yes
slopify tasks run batch.json --cwd /chemin/du/depot --json
```

Sans installation globale : `npm run slopify -- tasks run batch.json --json`.

## Initialisation d'un projet

```bash
slopify init [--cwd <projet>] [--host <pi|codex|all>] [--yes] [--json] [--verbose]
```

Sans `--host`, un terminal interactif propose un choix minimal; en contexte non
interactif il faut `--host` ou `--yes` (`all` par défaut). JSON ne demande jamais
de saisie et exige aussi l'un de ces choix. Le choix d'hôte peut rester interactif,
mais le téléchargement des skills est toujours automatique, non interactif et
local au projet cible. Ses sorties sont relayées sur stderr; stdout JSON contient
exactement un objet final.

Init installe les exemples V2 et conventions `.scratch`, puis la skill
`slopify-launch` sous `.pi/skills/` et/ou `.agents/skills/`. Il lance la CLI
`skills` en project-scope pour copier `mattpocock/skills`; celle-ci est seule à
gérer `skills-lock.json`. Un échec réseau devient un avertissement. Une relance
écrase sans sauvegarde chaque fichier possédé par init et préserve les autres.
Init ne lance jamais `sbx` et n'écrit rien globalement.

Il s'agit de l'adaptation V2 de l'issue historique #45 : Pi/Codex remplacent les
hôtes historiques, aucun `.acp` n'est installé et les ADR acceptées ne changent pas.

## Lot JSON

```json
{
  "specFile": "spec.md",
  "tasks": [
    {
      "id": "implement",
      "prompt": "$implement\nTexte complet du ticket et interfaces de test approuvées.",
      "agent": "codex",
      "dependsOn": [],
      "source": "issues/01-implement.md"
    },
    {
      "id": "verify",
      "prompt": "/skill:code-review Vérifier le résultat intégré selon la spec.",
      "agent": "pi",
      "dependsOn": ["implement"],
      "source": "batch.json"
    }
  ]
}
```

`specFile` est relatif au fichier JSON ; le chemin du lot est relatif au répertoire
d’appel. `source` conserve la référence du ticket ; son texte complet appartient
au `prompt`. Les prompts et invocations de skills sont transmis sans réécriture.
Seuls `pi` et `codex` sont acceptés. Les champs, identifiants, dépendances, cycles
et l’accès à la spec sont validés avant de créer un run, une branche ou un sandbox.
La vérification finale est une tâche ordinaire facultative du lot.

## Exécution et reprise

```bash
slopify tasks run batch.json [--base <ref>] [--cwd <repo>] [--store <dir>] [--json]
slopify tasks status <run-id> [--cwd <repo>] [--store <dir>] [--json]
slopify tasks resume <run-id> [--cwd <repo>] [--store <dir>] [--json]
slopify tasks resume-task <run-id> <task-id> [--cwd <repo>] [--store <dir>] [--json]
slopify tasks conflict <run-id> [--cwd <repo>] [--store <dir>] [--json]
slopify tasks resolve-conflict <run-id> --strategy <use-current|use-incoming|manual> [--cwd <repo>] [--store <dir>] [--json]
slopify tasks resolution <run-id> [--cwd <repo>] [--store <dir>] [--json]
slopify tasks validate-resolution <run-id> <resolution-id> [--cwd <repo>] [--store <dir>] [--json]
```

Le plafond est fixe : cinq tâches par vague, y compris après reprise. Un échec
bloque seulement ses descendants ; les tâches indépendantes continuent, sans
relance automatique. `resume` relance explicitement les échecs et interruptions,
et réutilise les résultats réussis. `resume-task` relance la tâche sélectionnée.
Une tentative encore marquée `running` doit être arrêtée avant sa reprise explicite ;
une reprise isolée attend si cinq autres tâches sont encore en cours. Les conflits suspendent les
nouveaux lancements jusqu’à une résolution explicite puis sa validation.

La base par défaut est `HEAD`. La branche dédiée `feature/slopify-<run-id>` est
publiée dans le dépôt hôte ; sa branche de travail et ses changements non commités
restent intacts. Les checkpoints, rapports, traces et contexte figé sont conservés.
Les sandboxes réussis sont supprimés après intégration ; ceux en échec ou en conflit
restent inspectables.

Le magasin durable est configurable avec `--store` ou `SLOPIFY_TASK_STORE` ; par
défaut il se trouve sous `~/.local/share/slopify/task-runs/`. Utiliser les mêmes
`--cwd` et `--store` pour les consultations et reprises.

Codes de sortie : **0** pour une exécution réussie ou une consultation réussie,
**2** pour une exécution échouée, interrompue ou en conflit (y compris les commandes
qui reprennent l’exécution), **1** pour une erreur d’entrée ou de commande.
Les commandes héritées `list`, `run <pipeline> <prompt>` et `resume --agent`
sont retirées et indiquent les commandes V2 à utiliser.

## Bibliothèques et validation

Le monorepo conserve `acp-pipeline`, `acp-runtime`, `acp-sandbox`, `acp-workspace`
et leurs tests hérités. Le moteur ACP reste disponible aux bibliothèques ; la CLI
expose uniquement les lots V2.

```bash
npm run build
npm test
```

Voir le [guide Pi](../docs/agents/coordinator-pi.md) pour la préparation, le suivi et le bilan.

## Suivi par l’agent hôte

`run` et les reprises annoncent le `runId` dès la première sauvegarde, puis publient les changements d’avancement sur stderr. Avec `--json`, ce sont des événements JSON par ligne (`type: "progress"`). stdout contient toujours un seul objet JSON final :

```bash
slopify tasks run batch.json --json > result.json 2> progress.jsonl
slopify tasks status <run-id> --json
```

Le statut conserve les champs existants et ajoute :

- `progress` : phase, compteurs par état, tâches en cours, résultats à intégrer, tâches prêtes et dépendances attendues ;
- `issues` : diagnostics du run et des dernières tentatives, causes d’échec, descendants bloqués et fichiers en conflit. Les anciens diagnostics désormais dépassés portent `historical: true` ;
- `nextActions` : descriptions, commandes sous forme de tableaux d’arguments et préconditions pour consulter, inspecter, reprendre ou valider une résolution.

La sortie texte présente aussi les codes de sortie des agents, les commits, rapports, logs et sandboxes retenus. `completed` signifie que le checkpoint attend encore l’intégration ; seul `succeeded` compte comme intégré. `running` est un état sauvegardé : vérifier que le précédent processus Slopify et l’ancien agent sont arrêtés avant de reprendre une tentative laissée en cours après un crash.

Les actions proposées sont informatives ; leur exécution reste explicite. Les erreurs d’entrée et de commande avec `--json` fournissent un objet `status: "invalid"` et des `diagnostics`.

## API

```typescript
import { TaskBatchService } from 'slopify/tasks';
const batches = new TaskBatchService({ repositoryPath: '/path/to/repository' });
const run = await batches.run('/path/to/batch.json', { baseRef: 'HEAD' });
const state = await batches.status(run.runId);
```
