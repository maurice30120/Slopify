# 02: Documenter et nettoyer les commentaires du package `slopify/`

**What to build:** Tous les symboles exportés (classes, interfaces, fonctions, types) de `slopify/src/` reçoivent un bloc JSDoc en français décrivant leur contrat public, et les commentaires existants du package subissent le triple traitement : suppression des redondants qui disent « quoi », conservation et clarification des architecturaux qui disent « pourquoi », promotion en JSDoc des inline qui décrivent un contrat public. Le package passe l'audit avec zéro symbole exporté non documenté.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Chaque classe (ex. `CliTerminal`), fonction (ex. `parseCliArgs`, `formatHelp`), interface et type (ex. `CliCommand`) exportés de `slopify/src/` a un bloc JSDoc
- [ ] Le JSDoc suit le pattern existant : description courte sur une ligne, `@param`, `@return`, en français
- [ ] Les descriptions emploient le vocabulaire exact de `CONTEXT.md` (Sandbox Run, Promotion, …) quand elles manipulent ces concepts
- [ ] Les commentaires redondants qui répètent ce que le code exprime déjà sont supprimés
- [ ] Les commentaires architecturaux (« pourquoi », décisions et historique) sont conservés et clarifiés, pas supprimés
- [ ] Les inline décrivant un contrat public sont promus en JSDoc
- [ ] L'audit ciblé sur `slopify/` (ticket 01) passe sans erreur