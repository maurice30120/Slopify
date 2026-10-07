# Documenter en français les classes et méthodes pertinentes des 5 packages actifs

Status: resolved
Spec: .scratch/documentation-fonctionnelle-fr/spec.md
Type: task

## Résumé

Ajouter une documentation TSDoc en français, orientée axe fonctionnel, sur les classes, interfaces et méthodes pertinentes des 5 packages actifs du workspace : orchestrateur CLI, bibliothèque de pipelines, runtime ACP, sandbox et workspace. Traduire les blocs de commentaires anglais existants (~84) dans le même cadre.

La spécification de référence est `.scratch/documentation-fonctionnelle-fr/spec.md`. Elle décrit l'axe fonctionnel attendu (rôle dans le cycle de vie d'un pipeline : Tâche d'implémentation, Sandbox Run, Agent Checkpoint, Pipeline Change Set, Integration Conflict, Promotion, Rejection, Cancellation), les invariants, les effets de bord et les cas d'erreur à documenter. Le glossaire du projet est la source de vérité du vocabulaire.

## Critères d'acceptation

1. Chaque classe, interface et méthode publique pertinente des 5 packages actifs porte un bloc TSDoc en français décrivant son rôle fonctionnel, ses invariants, ses effets de bord observables et ses conditions d'erreur.
2. Les symboles exportés par les points d'entrée publics de chaque package sont couverts en priorité ; les méthodes privées complexes sont documentées ; les symboles triviaux ne reçoivent pas de commentaire superflu.
3. Le vocabulaire employé est exactement celui du glossaire du projet.
4. Aucun bloc de commentaire anglais ne subsiste dans les 5 packages actifs (traduits en français, reformulés selon l'axe fonctionnel).
5. Aucune ligne de code n'est modifiée, supprimée ou déplacée : le diff ne contient que des lignes de commentaires.
6. Le build du workspace et toutes les suites de tests existantes passent sans modification de test.

## Hors périmètre

Package hérité `acp-sandcastle`, fichiers de build (`dist/`), renommage ou reformatage, documentation générée externe, nouvelles règles lint.

## Comments

- 2026-10-07 : livré par le pipeline `implement-ticket` (run `48e3d23f-59c2-42da-b5e5-bec93f480c9e`, agent `Codex Sandbox`). Diff de 58 fichiers (+1640/-121), 100 % lignes de commentaires. Validation sandbox puis hôte : build OK, 373 tests OK, 0 échec. Promotion du Pipeline Change Set (`d2ac02a46`) approuvée explicitement par l'utilisateur après rejet automatique de la confirmation interactive en processus d'arrière-plan.
- 2026-10-07 : remarque de revue — une partie des blocs de `acp-pipeline/src/PipelineService.ts` est stéréotypée (formule identique répétée par méthode) ; le reste de la couverture est spécifique au symbole documenté.
