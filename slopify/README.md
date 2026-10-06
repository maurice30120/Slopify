# Slopify

`slopify` exécute les pipelines ACP version 3 présents dans le workspace courant, sans lancer VS Code ni charger le plugin Pi comme extension.

```bash
slopify run "pipeline-name" "the user prompt" --agent "Codex CLI"
```

Le pipeline ne choisit pas de transport ni d'agent. `--agent` sélectionne
l'agent configuré dans `.acp/acp-agents.json` et l'applique à tous les nœuds
agent du pipeline. Le même choix doit être fourni lors d'une reprise après
redémarrage du processus.

## Niveaux de pipeline

Les trois niveaux recommandés sont disponibles directement par leur identifiant :

- `simple` : implémentation ciblée et vérification ;
- `moyen` : plan court, approbation, implémentation et revue ;
- `full` : clarification, spécification, tickets, implémentation séquentielle et revue.

L’identifiant historique `grill-spec-tickets-implement-review` reste disponible
avec le même déroulement que `full`. `implement-ticket` et `review-delivery`
restent des pipelines spécialisés utilisés par les livraisons fondées sur des
tickets.

Après un checkout neuf, installez les dépendances et construisez les workspaces
avant de lister ou lancer les pipelines :

```bash
npm ci
npm run build
npm run slopify -- list --json --cwd .
```

## Sources de configuration

Le CLI suit exactement la configuration du workspace :

- agents ACP natifs et agents Docker Sandbox Codex : `.acp/acp-agents.json` ;
- pipelines v3 : `.acp/pipelines/*.yaml` et `*.yml` ;
- instructions : `instructionsFile` résolu depuis la configuration du workspace ;
- skills explicites : `.agents/skills/<name>/SKILL.md`.

Il n'existe aucun pipeline ou catalogue d'agents embarqué. Un workspace non configuré échoue explicitement.

## Commandes

```bash
slopify list
slopify run moyen "Ajouter une commande export" --agent "Codex CLI"
slopify resume <run-id> --agent "Codex CLI"
```

Options :

```text
--cwd <path>  choisit le workspace
--agent <name> sélectionne l'agent configuré pour tous les nœuds agent
--yes, -y     approuve les pauses d'approbation uniquement
--keep-sandboxes conserve les Docker Sandboxes et affiche les commandes de diagnostic
--verbose     affiche les événements runtime
--json        sérialise la liste ou le résultat final
```

`--yes` ne valide jamais une Promotion. La politique du pipeline décide si le
Pipeline Change Set est rejeté, présenté à l’utilisateur, appliqué ou rejeté
automatiquement.

Les agents isolés supportés sont Codex et Mistral Vibe :

```json
{
  "agents": {
    "Codex Sandbox": {
      "transport": "sandbox",
      "agent": "codex",
      "model": "gpt-5.6-codex",
      "effort": "high"
    },
    "Vibe Sandbox": {
      "transport": "sandbox",
      "agent": "vibe",
      "model": "mistral-medium-latest"
    }
  }
}
```

## Runtime v3

Le CLI réutilise :

- `PipelineRuntime` et `PipelineRuntimeAgentAdapter` de `@acp-client/pipeline` ;
- les programmes compilés v3 du workspace ;
- `AcpRunner` pour lancer les agents ACP natifs ;
- `@acp-client/sandbox` pour lancer Codex dans Docker Sandbox ;
- les pauses génériques `question`, `approval` et `promotion` ;
- l'injection explicite des skills, y compris `grill-me` lorsqu'il est déclaré par un nœud.

Les pipelines v2 sont ignorés par le catalogue v3 et aucun mécanisme de compatibilité caché n'est ajouté.

## V2 task batches

V2 accepts a complete, approved specification and task graph prepared outside Slopify.
The dedicated entry point accepts only `pi` and `codex` per task:

```json
{
  "specFile": "spec.md",
  "tasks": [
    {
      "id": "implement",
      "prompt": "/implement\nThe complete approved ticket and testing interfaces.",
      "dependsOn": [],
      "agent": "codex",
      "source": "issues/01-implement.md"
    }
  ]
}
```

`specFile` resolves relative to the JSON file. `source` preserves a file or issue
reference; the full ticket text belongs in `prompt`. Skill invocations are passed
through without interpretation.

```sh
slopify tasks run ./batch.json --cwd ./repository --json
slopify tasks status <run-id> --cwd ./repository --json
```

`--base <ref>` selects a committed starting point (default `HEAD`). Uncommitted
host changes remain outside the run. `--store <directory>` overrides the durable
run store, also configurable with `SLOPIFY_TASK_STORE`; otherwise each repository
has a store under `~/.local/share/slopify/task-runs/`. The frozen specification,
prompts, references and base commit remain available through status after the
original files change or disappear. Invalid input returns diagnostics before
creating any run, branch or sandbox. The initial validated state is `ready`;
scheduling and external execution build on this same public batch interface.

The same API is exported from `slopify/tasks`:

```typescript
import { TaskBatchService } from 'slopify/tasks';
const batches = new TaskBatchService({ repositoryPath: '/path/to/repository' });
const run = await batches.run('/path/to/batch.json', { baseRef: 'HEAD' });
const state = await batches.status(run.runId);
```
