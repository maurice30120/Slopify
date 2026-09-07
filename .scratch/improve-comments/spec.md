## Problem Statement

Le code de Slopify (packages `slopify/`, `acp-pipeline/`, `acp-workspace/`, `acp-runtime/`, `acp-sandbox/`) contient des symboles exportés sans documentation JSDoc, et des commentaires existants parfois redondants avec le code, parfois absent des interfaces publiques. Les développeurs humains et les agents qui lisent le code n'ont pas une vision claire du contrat public de chaque symbole : cela ralentit la navigation, augmente le risque d'erreurs d'intégration et nuit à la lisibilité globale du code.

## Solution

Combiner deux volets complémentaires de nettoyage des commentaires de code :

1. **Comblage JSDoc sur les symboles publics** — Ajouter un bloc JSDoc à toutes les classes, interfaces, fonctions et types **exportés** (`export`) qui n'en disposent pas encore, en suivant le pattern existant (description courte, `@param`, `@return`). Les symboles internes non exportés ne sont pas documentés.
2. **Nettoyage / réécriture des commentaires existants** — Tripler le traitement de l'existant :
   - (a) supprimer les commentaires redondants (ceux qui disent « quoi », que le code lit déjà) ;
   - (b) conserver et clarifier les commentaires architecturaux (ceux qui disent « pourquoi » : intention, décision, historique) ;
   - (c) promouvoir en JSDoc les inline décrivant un contrat public.

Un script d'audit maison (`scripts/audit-docs.mjs`, compatible `node:test`) est introduit et intégré à la racine via un npm script, **bloquant en CI** : il échoue si un symbole exporté d'un package en scope n'a pas de JSDoc. La qualité rédactionnelle relève de la revue manuelle uniquement.

## User Stories

1. En tant que développeur, je veux que chaque classe, interface, fonction et type exporté ait un JSDoc, afin de comprendre son contrat public sans lire l'implémentation.
2. En tant qu'agent IA, je veux des descriptions JSDoc claires et concises, afin de générer du code qui respecte les interfaces existantes.
3. En tant que mainteneur, je veux que les commentaires redondants (qui disent « quoi ») soient supprimés, afin de réduire le bruit visuel dans le code.
4. En tant que mainteneur, je veux que les commentaires architecturaux (qui disent « pourquoi ») soient conservés et clarifiés, afin de préserver l'intention et l'historique des décisions.
5. En tant que développeur, je veux que les inline décrivant un contrat public soient promus en JSDoc, afin que le contrat soit documenté au bon endroit.
6. En tant que mainteneur, je veux un script d'audit bloquant en CI qui échoue si un symbole exporté n'a pas de JSDoc, afin de garantir la couverture continue.
7. En tant que développeur, je veux que le JSDoc suive les patterns existants (`@param`, `@return`, description courte), afin d'avoir une documentation cohérente.
8. En tant que contributeur, je veux que les commentaires soient en français et emploient le vocabulaire exact de `CONTEXT.md`, afin d'utiliser des termes de domaine précis.
9. En tant que développeur, je veux que seuls les symboles exportés soient documentés, afin de ne pas surcharger le code interne.
10. En tant que mainteneur, je veux que le script d'audit soit intégré à la racine et s'exécute dans le CI existant, afin d'empêcher les régressions de documentation.
11. En tant que mainteneur, je veux que la qualité rédactionnelle soit contrôlée par revue manuelle de code, afin d'éviter un outil automatique supplémentaire.
12. En tant que développeur, je veux que les classes publiques sans JSDoc (ex. `PipelineRuntime`) reçoivent un JSDoc décrivant leur responsabilité.
13. En tant que développeur, je veux que les interfaces publiques (ex. `CliTerminal`, `SkillCatalogEntry`, `PipelineRuntimeEvent`, `PipelineRuntimeOptions`, `PipelineRunStore`) reçoivent un JSDoc décrivant leur rôle.
14. En tant que développeur, je veux que les fonctions exportées (ex. `parseCliArgs`, `formatHelp`, `loadSkillCatalog`, `renderSkillsCatalog`) reçoivent un JSDoc avec `@param` et `@return`.
15. En tant que développeur, je veux que les types exportés (ex. `CliCommand`, `PipelineRuntimeEvent`) reçoivent un JSDoc décrivant leur signification.

## Implementation Decisions

- **Portée des commentaires** : commentaires de code uniquement, dans les deux volets (comblage JSDoc + nettoyage/réécriture). Le run commentary (ADR 0007) est hors périmètre.
- **Périmètre des fichiers** : les cinq packages TypeScript (`slopify`, `acp-pipeline`, `acp-workspace`, `acp-runtime`, `acp-sandbox`), sous `*/src/` uniquement. Sont hors scope : les fichiers de test (`.test.ts`), les smoke tests `.mjs`, et `.agents/skills/`.
- **Définition de « public »** : seuls les symboles `export` (classe, interface, fonction, type) reçoivent un JSDoc. Les symboles internes non exportés ne sont pas documentés. Ce périmètre est vérifiable automatiquement par le script d'audit.
- **Langue** : français, en employant les termes exacts du glossaire `CONTEXT.md` (Sandbox Run, Promotion, Agent Checkpoint, Pipeline Change Set, Integration Conflict, Rejection, Cancellation…) dans les descriptions des symboles qui manipulent ces concepts.
- **Traitement des commentaires existants** : triple traitement — (a) supprimer les redondants (« quoi »), (b) conserver + clarifier les architecturaux (« pourquoi »), (c) promouvoir en JSDoc les inline décrivant un contrat public. Règle de frontière : redondant = « quoi » vs architectural = « pourquoi ».
- **Script d'audit** : `scripts/audit-docs.mjs`, script maison compatible `node:test`, qui analyse récursivement les fichiers `.ts` sous `*/src/` (hors `.test.ts`), identifie les symboles exportés sans JSDoc et échoue s'il en subsiste. Intégré au package root via un npm script, bloquant en CI. Aucun ESLint introduit.
- **Conservation des commentaires architecturaux** : les inline `//` documentant des décisions non évidentes (idempotence de la fermeture de session pour un Sandbox Run, distinction Promotion/approbation dans `--yes`, historique ACP) sont conservés et éventuellement enrichis, pas supprimés.
- **Style** : suivre les patterns JSDoc existants dans le code (description courte sur une ligne, `@param`, `@return`).

## Testing Decisions

- **Script d'audit comme principale seam** : `scripts/audit-docs.mjs` est la seam de test convenue. Il est compatible `node:test`, analysable sans dépendance externe, et échoue (code de sortie non nul) dès qu'un symbole exporté d'un package en scope n'a pas de JSDoc.
- **Comportement attendu** : le script liste les symboles non documentés avec leur fichier et leur ligne ; il passe quand la couverture JSDoc des publics est complète.
- **Intégration CI** : le script est ajouté au workflow CI existant (via npm script root) pour bloquer les régressions à chaque push/PR.
- **Revue manuelle** : la qualité rédactionnelle des descriptions et réécritures est vérifiée par revue de code uniquement — pas de test automatisé pour la qualité rédactionnelle.
- **Prior art** : le pattern de script maison en `.mjs` est déjà utilisé dans le repo (ex. `slopify/scripts/build-resources.mjs`, `build-cli.mjs`).

## Out of Scope

- Le run commentary (ADR 0007).
- Les fichiers de test (`.test.ts`), les smoke tests `.mjs`, et `.agents/skills/`.
- Documenter les symboles internes non exportés (fonctions privées, variables locales).
- Introduire un linter complet (ESLint).
- Générer de la documentation utilisateur (README, guides).

## Further Notes

Le codebase contient déjà quelques JSDoc bien écrits (ex. dans `skillCatalog.ts` et `PipelineRuntime.ts`), servant de référence de style. La fenêtre `.scratch/improve-comments/` (spec + 8 tickets, datée du 7 sept.) est conservée comme contexte de référence pour organiser l'implémentation. Le script d'audit n'existe pas encore à ce jour : le périmètre « public = exporté » le rend vérifiable automatiquement.
