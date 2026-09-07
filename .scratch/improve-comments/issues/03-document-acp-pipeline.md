# 03: Documenter et nettoyer les commentaires du package `acp-pipeline/`

**What to build:** Tous les symboles exportés (classes, interfaces, fonctions, types) de `acp-pipeline/src/` reçoivent un bloc JSDoc en français décrivant leur contrat public, et les commentaires existants du package subissent le triple traitement : suppression des redondants (« quoi »), conservation et clarification des architecturaux (« pourquoi »), promotion en JSDoc des inline décrivant un contrat public. Le package passe l'audit avec zéro symbole exporté non documenté.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Chaque classe (ex. `PipelineRuntime`), interface (ex. `PipelineRuntimeEvent`, `PipelineRuntimeOptions`, `PipelineRunStore`), fonction et type exportés de `acp-pipeline/src/` a un bloc JSDoc décrivant son rôle
- [ ] Le JSDoc suit le pattern existant : description courte, `@param`, `@return`, en français
- [ ] Les descriptions emploient le vocabulaire ACP exact de `CONTEXT.md` (Promotion, Sandbox Run, Agent Checkpoint, Pipeline Change Set, Integration Conflict, …)
- [ ] Les commentaires redondants qui répètent le code sont supprimés
- [ ] Les commentaires architecturaux (« pourquoi », par ex. idempotence de la fermeture de session) sont conservés et clarifiés
- [ ] Les inline décrivant un contrat public sont promus en JSDoc
- [ ] L'audit ciblé sur `acp-pipeline/` (ticket 01) passe sans erreur