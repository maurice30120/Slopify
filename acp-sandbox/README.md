# @acp-client/sandbox

Runtime isolé actif de Slopify pour les agents Codex et Mistral Vibe. Il crée un clone privé
avec Docker Sandbox, exécute l’agent sans interaction, produit un Agent
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
    ,"Vibe Sandbox": {
      "transport": "sandbox",
      "agent": "vibe",
      "model": "mistral-medium-latest"
    }
  }
}
```

Les méthodes d’extension ACP publiques sont `sandbox/status`,
`sandbox/preview`, `sandbox/promote` et `sandbox/reject`.

## Smoke test réel Vibe

Le smoke test est désactivé par défaut. Il crée un dépôt temporaire et lance le
pipeline via la vraie CLI Slopify. Ce parcours clone une sandbox réelle, exécute
Vibe avec stdin fermé, récupère le checkpoint, calcule l’aperçu, exerce la
Promotion ou le rejet, puis vérifie que la sandbox a bien été supprimée.

```bash
SLOPIFY_SBX_SMOKE=1 npm run smoke:docker-sandbox-codex
SLOPIFY_SBX_SMOKE=1 SLOPIFY_SBX_SMOKE_ACTION=promote npm run smoke:docker-sandbox-codex
SLOPIFY_SBX_SMOKE=1 SLOPIFY_SBX_SMOKE_MODEL=mistral-medium-latest npm run smoke:docker-sandbox-codex
```

Vibe utilise le kit officiel `docker.io/sbx/vibe-kit:latest` : ce n’est pas un
agent intégré à `sbx create`. Le service `mistral` doit être authentifié dans
Docker Sandboxes (`sbx secret set mistral`). Le modèle est transmis dans la
sandbox par `sbx exec --env VIBE_ACTIVE_MODEL=...`.
