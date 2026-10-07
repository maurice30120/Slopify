# Documentation fonctionnelle en français des classes et méthodes pertinentes

Status: ready-for-agent

## Problem Statement

Le code du projet Slopify (5 packages actifs, environ 11 600 lignes de TypeScript) est aujourd'hui presque entièrement dépourvu de documentation : environ 84 blocs de commentaires seulement, en anglais, souvent triviaux. Un développeur qui ouvre une classe ou une méthode ne peut pas savoir, sans lire l'implémentation, quel rôle elle joue dans le cycle de vie du produit : préparation, Tâche d'implémentation, Sandbox Run, Agent Checkpoint, Pipeline Change Set, Promotion ou Rejection. Le glossaire (CONTEXT.md) définit un vocabulaire fonctionnel précis, mais celui-ci n'apparaît nulle part dans le code. Pour un humain comme pour un agent, la navigation et la reprise du code sont donc coûteuses et source de malentendus.

## Solution

Toutes les classes, interfaces et méthodes pertinentes des 5 packages actifs portent une documentation TSDoc en français, orientée sur l'axe fonctionnel : chaque symbole documenté explique le rôle qu'il joue dans le cycle de vie d'un pipeline (du découpage en tâches d'implémentation jusqu'à la promotion), ses invariants, ses effets de bord et ses cas d'erreur — jamais une paraphrase de son implémentation. Le vocabulaire du glossaire est utilisé systématiquement. Les rares commentaires anglais existants sont traduits et enrichis dans ce cadre. Aucun comportement, signature ou nommage n'est modifié.

## User Stories

1. En tant que développeur du projet, je veux lire en français, au-dessus de chaque classe pertinente, son rôle fonctionnel dans le cycle de vie d'un pipeline, pour comprendre le code sans devoir suivre son implémentation.
2. En tant que développeur du projet, je veux que chaque méthode publique pertinente explique ce qu'elle garantit (invariants), ce qu'elle modifie (effets de bord) et quand elle échoue (cas d'erreur), pour l'appeler en confiance.
3. En tant que développeur du projet, je veux que les termes utilisés dans les commentaires soient exactement ceux du glossaire (Sandbox Run, Agent Checkpoint, Pipeline Change Set, Integration Conflict, Promotion, Rejection, Cancellation, Tâche d'implémentation), pour qu'il n'y ait qu'un seul vocabulaire dans le projet.
4. En tant que nouveau contributeur, je veux ouvrir n'importe quel package et comprendre sa responsabilité dans l'architecture globale à partir de ses seuls commentaires, pour être productif sans accompagnement.
5. En tant que nouveau contributeur, je veux que les commentaires m'indiquent quel module appeler et lequel ne pas appeler (symboles internes vs points d'entrée), pour éviter de dépendre de détails d'implémentation.
6. En tant qu'agent d'implémentation, je veux pouvoir déterminer le rôle d'une classe ou méthode à partir de sa documentation, pour modifier le code sans introduire de régression sémantique.
7. En tant qu'agent d'implémentation, je veux que les commentaires restent cohérents avec les décisions des ADR (frontière sandbox du runtime, promotion comme politique du pipeline, etc.), pour ne pas documenter un comportement contredit par l'architecture.
8. En tant que réviseur d'une livraison, je veux vérifier en lisant le diff que seules des lignes de commentaires ont été ajoutées ou modifiées, pour valider l'absence de changement de comportement sans relire tout le code.
9. En tant que mainteneur, je veux que les commentaires des ~84 blocs anglais existants soient traduits en français avec le même axe fonctionnel, pour que le projet ait une documentation homogène.
10. En tant que mainteneur, je veux que les interfaces et types exportés documentent leurs champs non triviaux, pour comprendre les contrats de données sans lire le code qui les produit.
11. En tant que mainteneur, je veux que les méthodes privées complexes (algorithmes, coordination, gestion d'état) soient documentées elles aussi, pour que les parties difficiles ne deviennent pas des zones obscures.
12. En tant que mainteneur, je veux que les commentaires décrivent le comportement observable et non les détails d'implémentation, pour qu'ils survivent aux refacteurs.
13. En tant que développeur du package d'orchestration, je veux que chaque phase d'un pipeline documente ses transitions d'état et ses conditions de suspension (pause, Integration Conflict, abort), pour diagnostiquer un run bloqué.
14. En tant que développeur du runtime, je veux que les frontières entre le monde hôte et le monde sandbox soient explicitées dans la documentation, pour respecter les garanties d'isolation.
15. En tant qu'utilisateur du CLI, je veux que les points d'entrée (commandes, arguments) documentent leur effet observable sur le workspace, pour savoir ce que chaque commande fait avant de l'exécuter.
16. En tant que développeur, je veux que les annotations @param et @returns documentent les paramètres et retours non évidents (formats, unités, valeurs sentinelles), pour éviter les erreurs d'appel.

## Implementation Decisions

- Format : blocs TSDoc (`/** ... */`) en français, au-dessus des classes, interfaces, types exportés et méthodes publiques pertinentes des 5 packages actifs (orchestrateur CLI, bibliothèque de pipelines, runtime ACP, sandbox, workspace). Le package `acp-sandcastle` n'est pas touché (hérité, remplacé par les sandbox Docker selon l'ADR 0001).
- Axe fonctionnel : chaque bloc répond à « quel rôle dans le cycle de vie / quel contrat », pas à « comment c'est codé ». Sont documentés : la responsabilité du symbole, les invariants garantis, les effets de bord observables (fichiers écrits, événements émis, état muté), les conditions d'erreur et les transitions d'état (suspension, abort, reprise).
- Vocabulaire : les termes du glossaire du projet sont employés exactement (Tâche d'implémentation, Sandbox Run, Agent Checkpoint, Pipeline Change Set, Integration Conflict, Promotion, Rejection, Cancellation), avec leurs définitions du glossaire comme source de vérité unique.
- Priorité de couverture : d'abord les symboles exportés par les points d'entrée publics de chaque package, puis les classes de coordination et de politique, puis les méthodes privées complexes. Les getters/setters triviaux, les constructeurs sans particularité et les types évidents ne reçoivent pas de commentaire superflu.
- Homogénéisation : les blocs de commentaires anglais existants (~84) sont traduits en français et reformulés selon l'axe fonctionnel ; aucun contenu documentaire ne reste en anglais.
- Les blocs techniques utiles (`@param`, `@returns`, `@throws`, `@example` quand éclairant) sont conservés ou ajoutés, en français.
- Contrainte absolue : aucune modification de code, de signature, de nommage, d'import ou de formatage hors commentaire. Le diff produit ne doit contenir que des lignes de commentaires (ajouts) et les lignes remplacées des traductions.
- Les commentaires restent cohérents avec les ADR du projet, notamment : frontière du runtime comme limite sandbox (ADR 0003), promotion comme politique du pipeline (ADR 0004), checkpoints exigés des agents écrivant dans le workspace (ADR 0006), intégration des tâches dans une branche dédiée (ADR 0010).

## Testing Decisions

- Aucun nouveau seam de test n'est introduit : c'est une tâche de documentation pure. La validation s'appuie exclusivement sur les seams existants, au point le plus haut : le build du workspace et les suites de tests de chaque package.
- Un « bon test » ici est un test de non-régression : le build compile à l'identique, toutes les suites de tests existantes passent avant et après, sans la moindre modification de test.
- Critère supplémentaire vérifiable en revue : le diff ne contient que des lignes de commentaires ; toute ligne de code modifiée ou supprimée est un défaut.
- Modules concernés par la garde : les suites de tests existantes des 5 packages actifs et le build du workspace.
- Prior art : aucun — le projet n'a pas de tests de documentation ; la revue de diff est le mécanisme de contrôle.

## Out of Scope

- Le package hérité `acp-sandcastle`.
- Toute génération de documentation externe (HTML, site, publication de docs générées).
- Tout renommage, refacteur, réordonnancement d'imports ou reformatage du code.
- Les fichiers de build (`dist/`, sorties compilées) et les artefacts de run.
- Les commentaires triviaux ligne à ligne dans les corps de méthodes (seuls les blocs documentaires de symboles sont concernés).
- La documentation des tests et des scripts de smoke, sauf s'il s'agit de traduire des blocs anglais existants.
- L'ajout de règles lint imposant la présence de doc-comments (écarté lors de la revue des seams).

## Further Notes

- Le glossaire du projet est la source de vérité du vocabulaire ; en cas de divergence entre un commentaire et le glossaire, c'est le glossaire qui gagne.
- L'ordre de traitement recommandé est l'ordre des packages par criticité fonctionnelle : orchestrateur CLI, puis pipelines, puis runtime, puis sandbox, puis workspace.
- La validation finale est humaine autant qu'automatique : le diff doit se lire intégralement comme du commentaire.
