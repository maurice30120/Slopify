# 01: Commenter les exports publics d'acp-pipeline et établir la convention

**What to build:** Le package `acp-pipeline` — qui contient la logique métier centrale et la plus complexe du système — devient le premier paquet entièrement documenté, servant de **tracer bullet** : il établit la convention de commentaires que tous les autres packages suivront. Chaque export public (service, classe, type, enum, constante, fonction) reçoit un JSDoc structuré en français expliquant son rôle et ses invariants. En parallèle, ce ticket fixe et documente, dans les fichiers du package, la convention de style applicable à toute l'initiative : JSDoc structuré (`/** ... */`) avec `@param`, `@returns`, `@deprecated` sur les exports publics, commentaires `//` pour expliquer le *pourquoi* des logiques non triviales, langue française systématique réutilisant les 8 termes canoniques du glossaire `CONTEXT.md`. Le build TypeScript et la relecture valident le résultat.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Tous les exports publics de `acp-pipeline` (`PipelineService`, `PipelineV3Catalog`, `PipelineEvents`, `PipelineInterviewProtocol`, etc.) portent un JSDoc structuré en français décrivant leur rôle, sans laisser de `TODO: documenter` derrière.
- [ ] Les types/exports/constantes exportés (interfaces, enums, type aliases, constantes comme `PROMOTION_POLICIES`) ont un JSDoc décrivant leur rôle, leur signification et les valeurs possibles.
- [ ] Les fonctions complexes (async, callbacks/hooks, utilitaires garantissant des invariants) documentent en commentaire `//` ou dans le JSDoc les contraintes de concurrence, effets de bord et invariants non triviaux.
- [ ] Le style est cohérent : description sur la première ligne du JSDoc, tags sur les lignes suivantes ; pas de `@module`/`@namespace` ; commentaires `//` pour les explications locales (pas de `/* */` inline).
- [ ] Les commentaires liés aux concepts du glossaire utilisent les termes canoniques exacts de `CONTEXT.md` (Skill embarquée, Sandbox Run, Agent Checkpoint, Pipeline Change Set, Integration Conflict, Promotion, Rejection, Cancellation).
- [ ] Les commentaires existants (français ou anglais) ne sont pas réécrits ; seuls sont ajoutés les commentaires manquants sur les symboles importants.
- [ ] Les fonctions/types privés non exportés ne reçoivent pas de JSDoc obligatoire ; le bruit est minimal.
- [ ] La convention est stable et reproductible : elle est celle suivie par les tickets 02 à 05 (le package ne contredit pas le style adopté ensuite).
- [ ] `tsc --noEmit` passe sans erreur sur `acp-pipeline`.
- [ ] Le diff total, si > 500 lignes, est cohérent et relu ; l'initiative s'appuie sur ce ticket comme référence de style.
