# 04: Commenter les exports publics de slopify (CLI)

**What to build:** Le package `slopify`, qui implémente la CLI et le point d'entrée workflow de l'utilisateur, reçoit les commentaires manquants sur ses exports publics, en suivant la convention du ticket 01. Les commandes, gestionnaires d'arguments, backends de runtime et types exportés documentent en JSDoc français leur rôle dans le workflow utilisateur fin. Les logiques locales non triviales (gestion d'args, sous-commandes) reçoivent des commentaires `//` expliquant le *pourquoi*. Les commentaires existants ne sont pas réécrits. Le build et la relecture valident le résultat.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Les exports publics de `slopify` (CLI, `run`, `args`, `runtimeBackend`, etc.) portent un JSDoc structuré en français décrivant leur rôle dans le workflow utilisateur.
- [ ] Les types et constantes exportés ont un JSDoc décrivant leur rôle et les valeurs possibles.
- [ ] Les logiques locales non triviales (ex. parsing d'arguments, sous-commandes, sélection de backend) sont expliquées par des commentaires `//` sur le *pourquoi*.
- [ ] Les commentaires existants (français ou anglais) ne sont pas réécrits ; les symboles privés non exportés ne sont pas surchargés de JSDoc.
- [ ] `tsc --noEmit` passe sans erreur sur `slopify`.
