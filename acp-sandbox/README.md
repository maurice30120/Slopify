# @acp-client/sandbox

Runtime isolé actif de Slopify pour les agents Codex. Il crée un clone privé
avec Docker Sandbox, exécute `codex exec` sans interaction, produit un Agent
Checkpoint, prépare l’aperçu du Pipeline Change Set et ne modifie le workspace
hôte qu’après une Promotion explicite.

La configuration utilisateur se trouve uniquement dans
`.acp/acp-agents.json` :

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

Les méthodes d’extension ACP publiques sont `sandbox/status`,
`sandbox/preview`, `sandbox/promote` et `sandbox/reject`.

## Smoke test réel

Le smoke test est désactivé par défaut. Il crée un dépôt temporaire et lance le
pipeline via la vraie CLI Slopify. Ce parcours clone une sandbox réelle, exécute
Codex avec stdin fermé, récupère le checkpoint, calcule l’aperçu, exerce la
Promotion ou le rejet, puis vérifie que la sandbox a bien été supprimée.

```bash
SLOPIFY_SBX_SMOKE=1 npm run smoke:docker-sandbox-codex
SLOPIFY_SBX_SMOKE=1 SLOPIFY_SBX_SMOKE_ACTION=promote npm run smoke:docker-sandbox-codex
SLOPIFY_SBX_SMOKE=1 SLOPIFY_SBX_SMOKE_MODEL=gpt-5.4 npm run smoke:docker-sandbox-codex
```
