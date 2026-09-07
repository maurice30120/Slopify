## Problem Statement

Le codebase Slopify (171 fichiers `.ts` répartis sur 5 packages) présente des commentaires quasi inexistants sur la majorité des exports et types publics. Là où des commentaires existent, le style est hétérogène (JSDoc structuré vs `//` libre) et la langue oscille entre français et anglais, y compris au sein d'un même fichier. Le glossaire `CONTEXT.md` est intégralement en français, mais une grande part des commentaires existants sont en anglais. Cette situation nuit à la navigabilité du code, à la compréhension de l'intention derrière les choix d'implémentation, et à la cohérence linguistique du projet.

## Solution

Ajouter des commentaires JSDoc structurés (`/** ... */`) sur les exports publics et types, et des commentaires `//` pour les explications locales non triviales, en français. Unifier la langue sur le français pour les nouveaux commentaires. Ne pas réécrire les commentaires existants en anglais déjà en place — on harmonise les nouveaux, on ne réécrit pas tout le code.

## User Stories

1. En tant que développeur lisant `PipelineService.ts` pour la première fois, je veux un JSDoc sur l'export principal expliquant le rôle du service, afin de comprendre son purpose sans lire l'implémentation.
2. En tant que développeur examinant `pipelineCatalog.ts`, je veux un JSDoc sur le type/function exporté décrivant son rôle et ses paramètres, afin de l'utiliser correctement.
3. En tant que contributeur, je veux que tous les nouveaux commentaires soient en français, afin d'être cohérent avec le glossaire `CONTEXT.md`.
4. En tant que développeur, je veux que le style JSDoc soit structuré (`@param`, `@returns`, `@deprecated` quand pertinent) sur les exports publics, afin d'avoir une documentation machine-lectureable.
5. En tant que développeur, je veux que les commentaires `//` locaux expliquent le *pourquoi* (pas le *quoi*) quand la logique n'est pas triviale, afin de réduire la charge cognitive.
6. En tant que mainteneur, je veux que les commentaires existants en anglais ne soient pas modifiés, afin d'éviter une PR monstre de changements sans valeur ajoutée.
7. En tant que développeur, je veux que les types TypeScript exportés (interfaces, enums, type aliases) aient un JSDoc décrivant leur rôle, afin de naviguer l'API surface sans ouvrir les fichiers.
8. En tant que contributeur, je veux que les fonctions privées ou internes ne soient pas systématiquement commentées, afin de garder le bruit minimal.
9. En tant que développeur, je veux que les constantes exportées (ex. `PROPOSED_PLAN_PROTOCOL_ID`) aient un JSDoc expliquant leur signification, afin de comprendre leur rôle dans le système.
10. En tant que mainteneur, je veux que les commentaires ajoutés ne cassent pas le build TypeScript (`tsc --noEmit`), afin de garantir la validité syntaxique du JSDoc.
11. En tant que développeur, je veux que les enums exportés aient un JSDoc décrivant les valeurs et leur contexte d'utilisation, afin de choisir la bonne variante.
12. En tant que contributeur, je veux que les commentaires sur les fonctions async expliquent les contraintes de concurrence ou les effets de bord si non triviaux, afin d'éviter les bugs subtils.
13. En tant que développeur, je veux que les commentaires sur les classes exportées décrivent le pattern architectural qu'elles incarnent (ex. « Orchestrateur de pipeline », « Adaptateur de runtime »), afin de situer le code dans l'architecture.
14. En tant que mainteneur, je veux que les nouveaux commentaires soient atomiques avec le code qu'ils documentent (pas de « TODO: documenter plus tard »), afin de garder la dette technique minimale.
15. En tant que développeur, je veux que les types d'événements (ex. `PipelineEvents`) aient un JSDoc décrivant le contrat de chaque événement, afin de comprendre les interactions entre composants.
16. En tant que contributeur, je veux que les commentaires sur les fonctions utilitaires (ex. `compilePipelineV3Definition`) expliquent les invariants garantis, afin de ne pas casser ces invariants par accident.
17. En tant que développeur, je veux que les exports du package `slopify` (CLI) aient un JSDoc décrivant leur rôle dans le workflow utilisateur, afin de comprendre le point d'entrée.
18. En tant que mainteneur, je veux que les types internes non exportés n'aient pas de JSDoc obligatoire, afin de ne pas surcharger le code avec de la documentation pour des symboles invisibles de l'extérieur.
19. En tant que développeur, je veux que les commentaires sur les protocoles (ex. `PipelineInterviewProtocol`) décrivent le flow d'échange, afin de comprendre les états possibles.
20. En tant que contributeur, je veux que le format du JSDoc soit cohérent (description sur la première ligne, tags sur les lignes suivantes), afin de faciliter la lisibilité.
21. En tant que développeur, je veux que les constantes de configuration (ex. `PROMOTION_POLICIES`) aient un JSDoc décrivant les valeurs possibles et leur impact, afin de configurer correctement le système.
22. En tant que mainteneur, je veux que les erreurs custom (ex. `IntegrationConflictError`) aient un JSDoc expliquant les conditions de déclenchement, afin de les diagnostiquer plus facilement.
23. En tant que développeur, je veux que les fonctions acceptant des callbacks ou des hooks aient un JSDoc décrivant le contrat attendu du callback, afin de les implémenter correctement.
24. En tant que contributeur, je veux que les commentaires existants déjà en français soient préservés tels quels, afin d'éviter des changements cosmétiques inutiles.

## Implementation Decisions

- **Portée par package** : Les 5 packages (`acp-pipeline`, `acp-runtime`, `acp-workspace`, `acp-sandbox`, `slopify`) sont couverts. L'ordre de priorité suit la taille et la complexité : `acp-pipeline` (56 fichiers) en premier, puis `acp-runtime` (46), `acp-workspace` (27), `slopify` (26), `acp-sandbox` (16).
- **Cibles prioritaires** : Les fichiers sans aucun commentaire reçoivent d'abord un JSDoc sur les exports publics. Les fichiers avec des commentaires existants en français reçoivent des ajouts ciblés uniquement si des exports importants en manquent.
- **Convention JSDoc** : `/** Description courte. */` sur une ligne pour les symboles simples. Multi-lignes avec `@param`, `@returns`, `@deprecated` pour les fonctions complexes. Pas de `@module` ou `@namespace` (redondant avec la structure de packages).
- **Convention inline** : `//` pour les explications de non-linéarité, les avertissements de concurrence, les invariants non évidents, et les raisons historiques. Pas de `/* */` inline sauf dans du code commenté.
- **Langue** : Français pour tous les nouveaux commentaires. Les commentaires existants en anglais ne sont pas modifiés.
- **Restriction d'imports** : Les commentaires JSDoc ne doivent pas introduire de nouvelles dépendances ou imports. Les références à d'autres symboles dans les commentaires utilisent le nom simple, pas le chemin d'import.
- **Fichiers test** : Les fichiers `*.test.ts` ne reçoivent pas de JSDoc systématique. Un commentaire de description de suite de tests (`describe` block) est acceptable s'il aide à comprendre le scénario couvert.
- **Build check** : Chaque PR de commentaires doit passer `tsc --noEmit` sans erreur.

## Testing Decisions

- **Vérification** : `tsc --noEmit` sur chaque package pour valider que les commentaires JSDoc ne cassent pas le typage.
- **Pas de test unitaire** : Les commentaires ne sont pas testables unitairement. La vérification est syntaxique (build) et visuelle (relecture).
- **Relecture** : Chaque PR est relue pour vérifier la cohérence de la langue (français), du style (JSDoc structuré pour les exports, `//` pour les locaux), et de l'absence de commentaires existants modifiés.
- **Ordre de review** : Les packages `acp-pipeline` et `acp-runtime` sont reviewés en priorité car ils contiennent la logique métier centrale.

## Out of Scope

- **Génération TypeDoc** : Pas de configuration ni de script pour générer de la documentation automatisée.
- **Réécriture sémantique profonde** : Les commentaires existants (même mal rédigés) ne sont pas réécrits. On ajoute, on ne réforme pas.
- **Traduction des commentaires existants** : Les commentaires déjà en anglais restent en anglais. On harmonise les *nouveaux*, on ne traduit pas le code existant.
- **Commentaires sur les tests** : Pas de JSDoc obligatoire sur les fonctions de test. Les `describe`/`it` blocks peuvent avoir des descriptions, mais ce n'est pas prioritaire.
- **Documentation externe** : Pas de README, pas de guides d'utilisation, pas de doc API publique.
- **Lint rule pour les commentaires** : Pas de configuration ESLint/plugin pour forcer la présence de commentaires.

## Further Notes

- Le glossaire `CONTEXT.md` définit 8 termes canoniques en français (`Skill embarquée`, `Sandbox Run`, `Agent Checkpoint`, `Pipeline Change Set`, `Integration Conflict`, `Promotion`, `Rejection`, `Cancellation`). Les commentaires sur les symboles liés à ces concepts doivent utiliser ces termes exacts.
- Les ADRs existants dans `docs/adr/` sont en français et suivent un format standard. Les commentaires ne doivent pas contredire les décisions documentées dans les ADRs.
- La PR doit être de taille raisonnable — si elle dépasse 500 lignes de diff, elle doit être splitée par package.
