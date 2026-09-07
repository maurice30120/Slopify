# 03: Commenter les exports publics d'acp-workspace

**What to build:** Le package `acp-workspace` reçoit les commentaires manquants sur ses exports publics, en suivant la convention du ticket 01. Les services, classes, types, enums et constantes exportés documentent en JSDoc français leur rôle, leur pattern architectural (ex. « Adaptateur de workspace ») et les invariants garantis. Les logiques locales non triviales reçoivent des commentaires `//` expliquant le *pourquoi*. Les commentaires existants ne sont pas réécrits. Le build et la relecture valident le résultat.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Les exports publics de `acp-workspace` portent un JSDoc structuré en français décrivant leur rôle.
- [ ] Les classes exportées décrivent le pattern architectural qu'elles incarnent.
- [ ] Les types (interfaces, enums, type aliases) et constantes de configuration exportés ont un JSDoc décrivant leur rôle, leurs valeurs et leur impact.
- [ ] Les fonctions avec callbacks/hooks, async ou garantissant des invariants documentent ces aspects si non triviaux.
- [ ] Les commentaires existants (français ou anglais) ne sont pas réécrits ; les symboles privés non exportés ne sont pas surchargés de JSDoc.
- [ ] `tsc --noEmit` passe sans erreur sur `acp-workspace`.
