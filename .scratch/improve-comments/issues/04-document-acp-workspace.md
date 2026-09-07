# 04: Documenter et nettoyer les commentaires du package `acp-workspace/`

**What to build:** Tous les symboles exportés (classes, interfaces, fonctions, types) de `acp-workspace/src/` reçoivent un bloc JSDoc en français décrivant leur contrat public, et les commentaires existants du package subissent le triple traitement : suppression des redondants (« quoi »), conservation et clarification des architecturaux (« pourquoi »), promotion en JSDoc des inline décrivant un contrat public. Le package passe l'audit avec zéro symbole exporté non documenté.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Chaque interface (ex. `SkillCatalogEntry`), fonction (ex. `loadSkillCatalog`), classe et type exportés de `acp-workspace/src/` a un bloc JSDoc décrivant son rôle
- [ ] Le JSDoc suit le pattern existant : description courte, `@param`, `@return`, en français
- [ ] Les descriptions emploient le vocabulaire exact de `CONTEXT.md` (Skill embarquée, Sandbox Run, Promotion, …) quand elles manipulent ces concepts
- [ ] Les commentaires redondants qui répètent le code sont supprimés
- [ ] Les commentaires architecturaux (« pourquoi ») sont conservés et clarifiés
- [ ] Les inline décrivant un contrat public sont promus en JSDoc
- [ ] L'audit ciblé sur `acp-workspace/` (ticket 01) passe sans erreur