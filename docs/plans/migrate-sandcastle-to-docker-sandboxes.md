# Migration de Sandcastle vers Docker Sandboxes

## Objectif

Remplacer entièrement `@ai-hero/sandcastle` par Docker Sandboxes (`sbx`) pour les agents Codex, sans conserver de fallback Sandcastle. La migration doit réduire le code spécifique au runtime tout en renforçant l’isolation, en préservant ACP et en rendant la promotion atomique pour les pipelines multi-agents.

Pi et Vibe sont hors périmètre de cette première version. Ils seront ajoutés ultérieurement via `sbx`.

## Contrat cible

- Chaque nœud agent avec effets workspace utilise sa propre sandbox `sbx --clone`.
- Le workspace hôte reste inchangé pendant tout le pipeline.
- Slopify crée un Agent Checkpoint technique à la fin de chaque nœud ; il ne dépend pas d’un commit produit par Codex.
- Les checkpoints sont intégrés dans une branche de run selon l’ordre topologique du DAG, puis l’ordre de déclaration pour les nœuds parallèles de même niveau.
- Un conflit suspend le pipeline, expose les fichiers concernés et interdit toute promotion.
- Le Pipeline Change Set complet est promu atomiquement une seule fois, selon la politique du pipeline.
- Rejet, annulation et échec ne modifient jamais le workspace hôte.

## Architecture cible

### `acp-sandbox` (`@acp-client/sandbox`)

Remplace `acp-sandcastle` et contient deux modules profonds :

1. `DockerSandboxRuntime`
   - détecte les capacités et la version de `sbx` ;
   - crée une sandbox Codex nommée avec `--clone` ;
   - exécute Codex, diffuse stdout/stderr et propage annulation/timeouts ;
   - interroge `sbx ls --json` pour la reprise ;
   - exporte les diagnostics puis appelle `sbx rm --force`, sauf avec `--keep-sandboxes`.

2. `GitPromotion`
   - crée les Agent Checkpoints dans la sandbox via `sbx exec` ;
   - récupère les refs depuis le remote `sandbox-<name>` ;
   - calcule aperçu, fichiers modifiés et diff sans mutation hôte ;
   - intègre les checkpoints dans une branche de run déterministe ;
   - détecte et décrit les conflits ;
   - applique atomiquement le Pipeline Change Set après validation de la base ;
   - produit `applied`, `no_changes`, `rejected` ou `cancelled`.

Le bridge ACP reste la frontière publique. Les extensions deviennent `sandbox/status`, `sandbox/preview`, `sandbox/promote` et `sandbox/reject`. Aucun type public ne conserve le nom Sandcastle.

### `acp-workspace`

- Charge les agents ACP et sandbox depuis `.acp/acp-agents.json` uniquement.
- Remplace les types `Sandcastle*` par des types neutres `Sandbox*`.
- Orchestre une sandbox par nœud/tentative et une branche d’intégration par pipeline.
- Persiste dans le snapshot : nom de sandbox, commit de base, checkpoint, état d’intégration et diagnostics.
- Finalise une seule promotion au niveau du pipeline au lieu de promouvoir chaque agent.

### `acp-pipeline`

- Déplace `promotion` des politiques de nœuds vers la politique du pipeline.
- Retire `network: enabled|disabled` des politiques de nœuds.
- Modélise les états `checkpointed`, `integrating`, `integration_conflict` et `ready_for_promotion` sans dépendre de Docker.
- Conserve l’exécution parallèle actuelle des nœuds prêts.
- Intègre les checkpoints dans un ordre topologique stable, jamais dans l’ordre de fin.

### `slopify`

- Ajoute le préflight et ses erreurs correctives.
- Propose au premier usage les politiques réseau Docker : Open, Balanced et Locked Down.
- Ajoute `--keep-sandboxes` à `slopify run`.
- Affiche les noms et commandes d’inspection pour les sandboxes conservées.
- Présente un aperçu unique et une décision de promotion unique par pipeline.

## Configuration cible

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

Pour cette version, `agent` accepte uniquement `codex`. `provider`, `maxIterations`, `ACP_SANDCASTLE_IMAGE`, les homes de credentials copiés et les options d’image Sandcastle sont supprimés. CPU, mémoire, template et kit utilisent les valeurs par défaut de `sbx` et ne sont pas exposés.

Si `.acp/.sandcastle/config.json` existe, la CLI échoue avec une erreur de migration contenant :

- le chemin de l’ancien fichier ;
- la raison de son rejet ;
- un exemple de configuration `transport: "sandbox"` ;
- l’instruction de supprimer l’ancien fichier après migration manuelle.

## Politique réseau

Au premier lancement, Slopify reprend les choix Docker sans introduire son propre modèle :

| Choix CLI | Politique `sbx` |
|---|---|
| Open | `allow-all` |
| Balanced | `balanced` |
| Locked Down | `deny-all` |

La politique est globale et héritée par toutes les sandboxes. Les champs réseau par nœud sont supprimés. Après initialisation, les modifications passent par `sbx policy`.

## Préflight

Avant un pipeline avec effets workspace, vérifier dans cet ordre :

1. le workspace est un dépôt Git ;
2. `git status --porcelain` est vide ; sinon expliquer que `sbx --clone` ne verrait pas les changements locaux et que la promotion ne serait pas sûre ;
3. `sbx` est présent et `sbx version` rapporte une version au moins égale à `0.35.0` ;
4. les capacités `--clone`, `ls --json` et `policy init` sont disponibles ;
5. la politique réseau globale est initialisée ;
6. aucun identifiant de sandbox prévu pour le run n’est occupé par une ressource incompatible.

Les pipelines sans effets workspace ne sont pas bloqués par un workspace Git sale.

## Cycle de vie et reprise

Le nom suit une forme stable et compatible `sbx`, par exemple `slopify-<runId>-<nodeId>-<attempt>` après normalisation et ajout d’un suffixe hash pour éviter les collisions.

- Succès : checkpoint, export des logs, intégration, suppression.
- Rejet ou annulation : export des logs, suppression sans transfert.
- Échec : export des logs, suppression par défaut.
- `--keep-sandboxes` : aucune sandbox du pipeline n’est supprimée ; la CLI imprime les commandes `sbx run --name`, `sbx exec -it ... bash` et `sbx rm --force`.
- Crash/reprise : relire le snapshot et `sbx ls --json`; réutiliser uniquement une sandbox dont l’identité et la base correspondent. Toute divergence suspend la reprise sans relancer, supprimer ou promouvoir implicitement.

## Séquence d’implémentation

### 1. Verrouiller les contrats par des tests

- Ajouter les tests du nouveau parseur de configuration et des erreurs de migration.
- Ajouter les tests du préflight, notamment le workspace sale et les capacités `sbx` manquantes.
- Définir un faux exécuteur `sbx` pour tester sans microVM.
- Ajouter les tests de nommage, nettoyage idempotent et `--keep-sandboxes`.

### 2. Introduire `acp-sandbox`

- Renommer le workspace et le package.
- Créer un adaptateur de subprocess injecté, sans appels shell concaténés.
- Implémenter `create`, `exec`, `list`, `stop` et `remove` autour de la CLI.
- Porter le bridge ACP sous les noms neutres.
- Supprimer les providers, mounts, homes, logs et types provenant de Sandcastle.

### 3. Prototyper le parcours Codex isolé

Le prototype jetable du 24 juillet 2026 a validé ce parcours avec `sbx` 0.35.0
et Codex CLI 0.142.4. Son harness et son verdict sont conservés sous
`acp-sandcastle/prototype/docker-sandbox-codex/`. L'implémentation doit fermer
stdin lors de `codex exec` afin de garantir le mode non interactif.

- Créer une sandbox Codex avec `--clone` et un nom déterministe.
- Exécuter une tâche non interactive et vérifier le streaming/annulation.
- Créer un commit technique via `sbx exec` avec une identité Git Slopify dédiée.
- Récupérer la ref via `sandbox-<name>` et produire un diff sans mutation hôte.
- Tester promotion et rejet, puis suppression.

Le prototype est une porte de validation : ne pas poursuivre la suppression finale de Sandcastle si le prompt non interactif, le checkpoint ou le fetch du remote ne sont pas fiables.

### 4. Construire l’intégration multi-agent

- Étendre le snapshot avec les métadonnées de sandbox et checkpoint.
- Créer une branche d’intégration privée par run.
- Intégrer selon l’ordre topologique et l’ordre de déclaration.
- Pauser sur conflit avec diagnostic structuré.
- Calculer un aperçu global et effectuer une seule promotion atomique.
- Vérifier qu’un retry remplace seulement le checkpoint de la tentative concernée.

### 5. Simplifier politiques et configuration

- Déplacer la promotion au niveau pipeline.
- Supprimer le réseau des politiques de nœuds.
- Ajouter l’initialisation Open/Balanced/Locked Down.
- Unifier le catalogue dans `.acp/acp-agents.json`.
- Retirer les compatibilités et valeurs par défaut Sandcastle.

### 6. Basculer la CLI et supprimer Sandcastle

- Remplacer tous les libellés et options utilisateur.
- Supprimer `@ai-hero/sandcastle`, `acp-sandcastle` et `.acp/.sandcastle` du code, des tests et de la documentation.
- Renommer `SANDCASTLE_BASELINE_CAPABILITIES` et les événements associés.
- Mettre à jour README, exemples et messages d’erreur.
- Vérifier avec `rg -i sandcastle` que seules l’histoire de migration et les erreurs dédiées à l’ancien fichier subsistent.

### 7. Validation réelle

- Exécuter la suite unitaire complète.
- Exécuter un parcours Codex réel : succès sans changement, changement promu, rejet, annulation, erreur, timeout et `--keep-sandboxes`.
- Exécuter deux agents parallèles sans conflit puis avec conflit.
- Simuler un crash après création, après checkpoint et avant promotion, puis reprendre.
- Vérifier qu’aucun scénario avant promotion ne modifie le workspace hôte.

## Critères d’acceptation

- `package-lock.json` ne contient plus `@ai-hero/sandcastle`.
- Aucun runtime, type public ou texte utilisateur actif ne porte le nom Sandcastle.
- Un pipeline write sur workspace sale échoue avant la création d’une sandbox avec une explication corrective.
- Deux agents parallèles produisent des checkpoints attribués et un résultat reproductible.
- Un conflit suspend le pipeline sans mutation hôte.
- Une promotion applique tout le Pipeline Change Set ou rien.
- Rejet, annulation, échec et crash ne promeuvent aucun changement.
- La reprise ne réutilise jamais une sandbox dont la base ne correspond pas.
- Le nettoyage est idempotent et `--keep-sandboxes` conserve et documente toutes les sandboxes du run.
- La configuration réseau utilise uniquement Open, Balanced ou Locked Down.

## Hors périmètre

- Pi et Vibe ;
- résolution automatique des conflits par un agent ;
- support des workspaces Git sales par snapshot ;
- exposition de CPU, mémoire, templates ou kits ;
- SDK Docker Sandboxes non documenté ;
- maintien d’un fallback ou d’une compatibilité d’exécution Sandcastle.
