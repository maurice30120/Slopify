# Slopify

`slopify` exécute les pipelines ACP version 3 présents dans le workspace courant, sans lancer VS Code ni charger le plugin Pi comme extension.

```bash
slopify run "pipeline-name" "the user prompt"
```

Le pipeline choisit les agents de chaque nœud. La commande n'accepte volontairement aucun argument `--agent`.

## Sources de configuration

Le CLI suit exactement la configuration workspace-root de la branche pipeline v3 :

- agents ACP natifs : `.acp/acp-agents.json` ;
- agents Sandcastle et politique de promotion : `.acp/.sandcastle/config.json` ;
- pipelines v3 : `.acp/pipelines/*.yaml` et `*.yml` ;
- prompts : `promptFile` résolu depuis la configuration du workspace ;
- skills explicites : `.agents/skills/<name>/SKILL.md`.

Il n'existe aucun pipeline ou catalogue d'agents embarqué. Un workspace non configuré échoue explicitement.

## Commandes

```bash
slopify list
slopify run plan-execute-verify "Ajouter une commande export"
```

Options :

```text
--cwd <path>  choisit le workspace
--yes, -y     approuve les pauses d'approbation uniquement
--verbose     affiche les événements runtime
--json        sérialise la liste ou le résultat final
```

`--yes` ne valide jamais une promotion. Les promotions Sandcastle restent soumises à `.acp/.sandcastle/config.json` et, lorsque la politique vaut `ask`, à une décision terminal explicite.

## Runtime v3

Le CLI réutilise :

- `PipelineRuntime` et `PipelineRuntimeAgentAdapter` de `@acp-client/pipeline` ;
- les programmes compilés v3 du workspace ;
- `EphemeralAcpRunner` pour lancer les agents ACP et Sandcastle ;
- les pauses génériques `question`, `approval` et `promotion` ;
- l'injection explicite des skills, y compris `grill-me` lorsqu'il est déclaré par un nœud.

Les pipelines v2 sont ignorés par le catalogue v3 et aucun mécanisme de compatibilité caché n'est ajouté.
