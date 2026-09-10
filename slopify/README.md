# Slopify

`slopify` fournit des pipelines ACP version 3 utilisables dans les autres projets, sans lancer VS Code ni charger une extension. Les pipelines du projet peuvent compléter ceux fournis.

```bash
slopify run "the user prompt"
```

Le pipeline choisit les agents de chaque nœud. La commande n'accepte volontairement aucun argument `--agent`. Le pipeline se fixe avec `--pipeline`/`-p` (défaut : `grill-spec-tickets-implement-review`) ; tous les arguments positionnels forment le prompt.

## Sources de configuration

La CLI embarque les pipelines `grill-spec-tickets-implement-review`,
`implement-ticket` et `review-delivery`, leurs instructions, leurs skills et
une configuration d’agents Vibe (ACP natif), Vibe Sandbox et OpenCode. Le
pipeline par défaut et ses pipelines de livraison utilisent Vibe Sandbox ;
OpenCode reste disponible pour les pipelines personnalisés. Elle localise ces ressources
relativement à son installation, indépendamment du répertoire courant.

Le projet peut fournir :

- `.acp/acp-agents.json` : ses agents remplacent les agents par défaut de même nom ;
- `.acp/pipelines/*.yaml` ou `*.yml` : ses pipelines complètent le catalogue et remplacent ceux de même ID ;
- `.agents/skills/<dossier>/SKILL.md` : ses méthodes spécifiques.

Les références de skills sont explicites : `slopify:code-review` désigne la
méthode fournie, `project:code-review` celle du projet. Un nom simple comme
`code-review` conserve la résolution locale au projet. Une skill locale ne
remplace jamais implicitement une skill `slopify:`.

Tous les agents des pipelines fournis s’exécutent dans Docker Sandbox, y compris
la planification, la spécification et la revue. Docker Sandbox (`sbx`) doit être
installé et les agents authentifiés pour cet environnement. OpenCode utilise
`run --auto` et Codex désactive ses confirmations internes dans la sandbox.
La politique réseau est globale (`sbx policy`), sans réglage par étape.
Un projet peut déclarer explicitement un agent ACP natif si une intégration
nécessite un accès à l’hôte. Les étapes
qui utilisent le tracker exigent un fichier non vide
`docs/agents/issue-tracker.md` décrivant le workflow du projet. Les skills
manquantes, désactivées pour l’agent ou privées d’un prérequis déclaré bloquent
le lancement avant toute connexion d’agent.

## Transmission et reprise des skills

Le prompt ACP contient les noms, descriptions et chemins absolus des skills,
avec une consigne de lecture obligatoire pour celles déclarées par l’étape.
Les autres skills autorisées à la découverte sont présentées pour lecture à
la demande. Les dépendances d’une skill imposée restent visibles même lorsque
leur découverte automatique est désactivée.

Au démarrage, Slopify fige les dossiers complets des skills et le programme
compilé dans le répertoire Git `slopify/resources/<identifiant>/` (obtenu via
`git rev-parse --git-path`). Hors dépôt Git, il utilise
`.acp/runs-v3/resources/`. Les scripts, références et templates sont conservés.
Les lectures ACP autorisent ce répertoire ; les écritures ACP le refusent.

Dans Docker Sandbox, les fichiers sont installés en lecture seule sous
`/tmp/slopify-resources/<identifiant>/`, hors du clone. Le prompt utilise les
chemins de la sandbox. Ces ressources ne font donc pas partie des Agent
Checkpoints.

Une reprise utilise la copie d’origine, même après une mise à jour de Slopify
ou des skills du projet. Si les fichiers figés ont disparu ou changé, elle
échoue explicitement : il faut restaurer la copie d’origine. Les ressources
restent conservées avec les runs ; aucun nettoyage automatique ni catalogue
personnel global n’est fourni dans cette version.

## Distribution

`resources.manifest.json` sélectionne les pipelines, les instructions et les
skills à distribuer, déclare leurs dépendances et les fichiers requis. Le build
vérifie ces références et copie intégralement les dossiers sélectionnés. Les
paramètres d’agents distribués proviennent de `default-agents.json`, jamais de
la configuration personnelle du développeur.

L’exécutable distribué est compilé avec ses dépendances internes, sans chemin
`file:../…` requis lors de l’installation :

```bash
npm pack -w slopify
npm install -g ./slopify-0.1.0.tgz
```

`npm run test:package -w slopify` vérifie l’installation hors monorepo et la
découverte des pipelines dans un projet vide, sans accès réseau.

## Commandes

```bash
slopify list
slopify run "Ajouter une commande export"
slopify run -p implement-ticket "Corriger le bug"
slopify resume <run-id>
```

Options :

```text
--pipeline, -p <name>  choisit le pipeline (défaut : grill-spec-tickets-implement-review)
--cwd, -c <path>       choisit le workspace
--yes, -y              approuve les pauses d'approbation uniquement
--keep-sandboxes, -k   conserve les Docker Sandboxes et affiche les commandes de diagnostic
--verbose, -v          affiche les événements runtime
--json, -j             sérialise la liste ou le résultat final
--help, -h             affiche l'aide
```

Les questions, les résultats Markdown et le streaming `--verbose` sont mis en
forme automatiquement sur un terminal interactif. Une sortie redirigée conserve
le texte brut. Pour désactiver les rafraîchissements ANSI du streaming dans un
terminal incompatible, utiliser `SLOPIFY_ANSI_STREAM=0`.

`--yes` ne valide jamais une Promotion. La politique du pipeline décide si le
Pipeline Change Set est rejeté, présenté à l’utilisateur, appliqué ou rejeté
automatiquement.

Vibe est disponible comme agent ACP natif lorsque `vibe-acp` est
installé et que `MISTRAL_API_KEY` est présent dans l’environnement :

```json
{
  "agents": {
    "Vibe": {
      "transport": "acp",
      "command": "vibe-acp",
      "args": [],
      "env": {}
    }
  }
}
```

Vibe est aussi disponible dans une sandbox Docker via le kit local
`.sbx/vibe/spec.yaml` :

```json
{
  "agents": {
    "Vibe Sandbox": {
      "transport": "sandbox",
      "agent": "vibe",
      "model": "mistral-medium-3.5",
      "kit": "./.sbx/vibe"
    }
  }
}
```

Le kit doit être validé avec `sbx kit validate ./.sbx/vibe` conformément à la
[documentation Docker des Sandbox Kits](https://docs.docker.com/ai/sandboxes/customize/).
Pour configurer l’authentification du sandbox, saisir la clé sur l’hôte une
seule fois avec `sbx secret set mistral`. La vraie clé reste gérée par Docker
et n’est pas ajoutée au JSON ni passée directement au conteneur. Le mode ACP
natif utilise quant à lui `MISTRAL_API_KEY` dans l’environnement du processus.

Un agent isolé accepte Codex ou OpenCode :

```json
{
  "agents": {
    "Codex Sandbox": {
      "transport": "sandbox",
      "agent": "codex",
      "model": "gpt-5.6-codex",
      "effort": "high"
    }
  }
}
```

Un agent OpenCode peut déclarer `opencodeConfig` : le fragment JSON est écrit
tel quel dans `~/.config/opencode/config.json` de la sandbox à chaque exécution
(l’image n’embarque pas les providers du workspace). Les clés n’y apparaissent
jamais en clair — le placeholder `{env:OPENCODE_GO_API_KEY}` est résolu par le
proxy Docker Sandbox via `sbx secret set-custom`. La variable d’environnement
est figée à la création de la sandbox : une sandbox créée avant le stockage du
secret ne la recevra jamais, même après redémarrage :

```json
{
  "agents": {
    "OpenCode Sandbox": {
      "transport": "sandbox",
      "agent": "opencode",
      "model": "opencode-go/glm-5.2",
      "effort": "high",
      "opencodeConfig": {
        "provider": {
          "opencode-go": {
            "npm": "@ai-sdk/openai-compatible",
            "name": "OpenCode Go",
            "options": {
              "baseURL": "https://opencode.ai/zen/go/v1",
              "apiKey": "{env:OPENCODE_GO_API_KEY}"
            },
            "models": {
              "glm-5.2": { "name": "GLM 5.2" }
            }
          }
        }
      }
    }
  }
}
```

Au premier démarrage, OpenCode normalise et réécrit `config.json` (il y ajoute
notamment `$schema`) : le fragment injecté est un bootstrap, pas un contrat
stable.

## Runtime v3

Le CLI réutilise :

- `PipelineRuntime` et `PipelineRuntimeAgentAdapter` de `@acp-client/pipeline` ;
- les programmes compilés v3 embarqués et ceux du workspace ;
- `AcpRunner` pour lancer les agents ACP natifs ;
- `@acp-client/sandbox` pour lancer Codex ou OpenCode dans Docker Sandbox ;
- les pauses génériques `question`, `approval` et `promotion` ;
- le catalogue des skills et leurs copies figées par run.

Les pipelines v2 sont ignorés par le catalogue v3 et aucun mécanisme de compatibilité caché n'est ajouté.
