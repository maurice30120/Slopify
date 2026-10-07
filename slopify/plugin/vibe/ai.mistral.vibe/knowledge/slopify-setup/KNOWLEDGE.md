---
name: slopify-setup
description: "Prérequis et configuration pour utiliser Slopify dans un projet : installation de sbx et des skills officielles, configuration .acp/ (agents, pipelines), règles de sécurité du workspace et récupération d'un run terminal."
display_name: Slopify Setup
icon: wrench
---

# Configurer Slopify dans un projet

À lire pour préparer un workspace à exécuter des pipelines Slopify, ou pour
diagnostiquer un échec de lancement lié à l'environnement.

## Prérequis système

- Node >= 22.19.
- Docker en fonctionnement (les Sandbox Runs s'exécutent dans des conteneurs).
- La CLI `sbx` >= 0.35.0 (`sbx --version`), avec le support de
  `sbx create --skills readonly` et des capacités `clone`/`list`.
- Les skills officielles installées pour la sandbox :
  `sbx skills add mattpocock/skills` (elles fournissent `implement`, `tdd`,
  `code-review`, exigées et vérifiées par le préflight).

## Configuration du workspace

Slopify lit sa configuration dans `<workspace>/.acp/` :

- **Agents** : `.acp/acp-agents.json` — la clé exacte de chaque entrée
  `agents` est le nom passé à `--agent`. Modèle complet :
  [acp-agents.example.json](acp-agents.example.json). Trois transports :
  `stdio` local (commande CLI), `sandbox` + `codex`, ou `sandbox` + `vibe`.
  Le bloc `pipeline.timeouts` (initializeMs, promptMs) borne les nœuds.
- **Pipelines** : `.acp/pipelines/*.yaml`, schéma `version: 3`. Les six
  niveaux de référence sont copiés dans [pipelines/](pipelines/) :
  `simple` (implémentation locale), `moyen` (plan court → implémentation →
  revue), `full` / `grill-spec-tickets-implement-review` (clarification →
  spec → tickets → implémentation → revue), `implement-ticket` (un ticket
  approuvé), `review-delivery` (revue d'une livraison).
- Chaque nœud déclare ses `skills` par nom ; elles sont résolues depuis
  `<workspace>/.agents/skills/` et montées en lecture seule dans la sandbox.
- Un nœud qui écrit dans le workspace (`filesystem: workspace-write`)
  produit un Agent Checkpoint durable ; un nœud en lecture seule n'en
  produit pas.

## Règles de sécurité du workspace

- **Workspace Git propre obligatoire** pour tout pipeline écrivant dans le
  workspace : `sbx --clone` ne voit pas les changements non commités, donc
  la Promotion atomique serait impossible. Committer ou retirer les
  changements locaux avant de lancer. Ce contrôle ne s'applique pas aux
  nœuds en lecture seule.
- **La Promotion est toujours une décision explicite et interactive** :
  `--yes` approuve les pauses ordinaires, jamais la Promotion finale. Un
  run lancé en arrière-plan sans stdin se termine donc par `cancelled` /
  "Pipeline Change Set Promotion rejected." après un travail réussi.
- `.acp/logs/` est vidé à chaque lancement : le run courant y écrit
  `<date>-<pipelineId>-<runId>.jsonl`.

## Récupérer un run terminal

L'état durable d'un run vit dans
`.acp/runs-v3/workspace/runs/<runId>/snapshot.json`. Après un rejet de
Promotion (pas après un échec d'agent), l'Agent Checkpoint existe comme
commit dans le dépôt (`checkpoint.checkpointCommit` dans le snapshot),
parenté sur le commit de base du run : une Promotion manuelle revient à un
`git merge --ff-only <commit>` après décision explicite de l'utilisateur.
Un run à l'état terminal n'accepte pas `slopify resume`.

## Workflow complet (spec → tickets → implémentation)

Les skills `to-spec` et `to-tickets` proviennent de
`mattpocock/skills`. Dans un nouveau projet, installer ce jeu de skills
côté hôte pour couvrir le flux complet ; les conventions du tracker local
sont décrites dans la connaissance `issue-tracker`.
