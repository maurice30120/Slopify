# 05: Commenter les exports publics d'acp-sandbox

**What to build:** Le package `acp-sandbox`, plus petit et plus simple, reçoit les commentaires manquants sur ses exports publics, en suivant la convention du ticket 01. Les services d'isolation, types, enums et constantes exportés documentent en JSDoc français leur rôle et les invariants qu'ils garantissent pour l'exécution isolée (Sandbox Run). Les logiques locales non triviales reçoivent des commentaires `//` expliquant le *pourquoi*. Les commentaires existants ne sont pas réécrits. Le build et la relecture valident le résultat.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Les exports publics de `acp-sandbox` portent un JSDoc structuré en français décrivant leur rôle.
- [ ] Les types (interfaces, enums, type aliases) et constantes exportés ont un JSDoc décrivant leur rôle et leurs valeurs.
- [ ] Les fonctions garantissant des invariants d'isolation ou de sécurité documentent ces invariants si non triviaux.
- [ ] Les commentaires liés au concept « Sandbox Run » utilisent le terme canonique français du glossaire `CONTEXT.md`.
- [ ] Les commentaires existants (français ou anglais) ne sont pas réécrits ; les symboles privés non exportés ne sont pas surchargés de JSDoc.
- [ ] `tsc --noEmit` passe sans erreur sur `acp-sandbox`.
