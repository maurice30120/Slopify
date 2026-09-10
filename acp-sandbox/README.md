# @acp-client/sandbox

Runtime isolé actif de Slopify pour les agents Codex, Copilot, OpenCode et Vibe. Il crée
un clone privé avec Docker Sandbox, exécute l’agent sans interaction, produit
un Agent Checkpoint, prépare l’aperçu du Pipeline Change Set et ne modifie le
workspace hôte qu’après une Promotion explicite.

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

Pour `Copilot Sandbox`, Slopify copie le dossier hôte `~/.copilot` dans
`/home/agent/.copilot` de la sandbox avant de lancer Copilot CLI. L’état est
transféré par `sbx cp -L`, protégé contre les accès groupe/autres, et reste
hors du workspace cloné et des Agent Checkpoints. Les variables de token
injectées par le service Docker sont neutralisées pour laisser Copilot utiliser
l’état copié. Si le dossier n’existe pas, Slopify laisse Copilot utiliser
l’authentification Docker Sandbox éventuellement disponible.

Les méthodes d’extension ACP publiques sont `sandbox/status`,
`sandbox/preview`, `sandbox/promote` et `sandbox/reject`.

Le kit Vibe local est `.sbx/vibe/spec.yaml`. Il s’installe et s’authentifie
avec le service de secret Docker Sandbox :

```bash
sbx kit validate ./.sbx/vibe
sbx secret set mistral
```

La clé réelle reste sur l’hôte ; le kit déclare `MISTRAL_API_KEY` comme
credential géré par le proxy.

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
