# 02: Commenter les exports publics d'acp-runtime

**What to build:** Le package `acp-runtime` (deuxième priorité de par sa complexité métier) reçoit les commentaires manquants sur ses exports publics, en suivant la convention établie par le ticket 01. Les services et adaptateurs de runtime, leurs types, enums, constantes et fonctions documentent en JSDoc français leur rôle, leurs invariants et, le cas échéant, les contraintes de concurrence ou de protocole d'échange. Les commentaires existants ne sont pas réécrits ; seuls sont ajoutés ceux qui manquent sur les exports importants. Le build et la relecture valident le résultat.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Les exports publics de `acp-runtime` (adaptateurs, types, protocoles) portent un JSDoc structuré en français décrivant leur rôle et leurs paramètres/retours pertinents.
- [ ] Les types exportés (interfaces, enums, type aliases) ont un JSDoc décrivant leur rôle et, pour les enums, les valeurs/contexte d'utilisation.
- [ ] Les fonctions async et celles avec callbacks/hooks documentent leurs contraintes de concurrence, effets de bord et le contrat attendu des callbacks si non triviaux.
- [ ] Les commentaires liés au glossaire utilisent les termes canoniques français de `CONTEXT.md`.
- [ ] Les commentaires existants (français ou anglais) ne sont pas réécrits.
- [ ] Les symboles privés non exportés ne reçoivent pas de JSDoc obligatoire.
- [ ] `tsc --noEmit` passe sans erreur sur `acp-runtime`.
