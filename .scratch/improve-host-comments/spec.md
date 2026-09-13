## Problem Statement

Les commentaires de `slopify/src/host.ts` ne rendent pas toujours explicites les décisions et invariants non évidents du module hôte : cycle de vie des runs, conservation d’un run en pause, Reprise, restauration, nettoyage terminal, journalisation et streaming. Un commentaire est également en anglais, ce qui rompt l’homogénéité du fichier.

## Solution

Réécrire et compléter uniquement les commentaires de `slopify/src/host.ts`, en français homogène, concis et clair. Ils doivent expliquer les raisons et invariants non évidents sans paraphraser le code. La documentation couvre notamment le maintien des runs en pause pour la Reprise, le nettoyage des runs terminaux et des caches, la restauration depuis le run store, le rattachement des événements ACP aux logs, le filtrage du diagnostic asynchrone de fin d’agent, la séparation affichage verbeux/persistance des pensées, ainsi que les deltas, textes cumulatifs et rendu Markdown par blocs.

Les noms techniques, événements ACP et noms de variables d’environnement restent inchangés. Le comportement, les types, signatures, imports, structure d’exécution et ordre des opérations restent strictement inchangés.

## User Stories

1. En tant que mainteneur, je veux comprendre pourquoi un run en pause reste attaché à son runtime, afin de préserver ses sessions lors d’une Reprise.
2. En tant que mainteneur, je veux comprendre pourquoi un résultat terminal nettoie le runtime, les journaux et l’état indexé, afin d’éviter les états périmés et les fuites mémoire.
3. En tant que développeur, je veux distinguer Reprise, Réparation et nouvelle tentative, afin de ne pas confondre les parcours de récupération.
4. En tant que développeur, je veux comprendre l’association des événements ACP aux logs de run ou de nœud, afin de préserver leur cohérence.
5. En tant qu’opérateur, je veux savoir pourquoi `Agent "…" exited (code=…, signal=SIGTERM)` peut être une libération normale lors d’une pause, afin de ne pas le confondre avec un crash.
6. En tant que développeur, je veux comprendre pourquoi les pensées sont assainies avant persistance mais peuvent être affichées en mode verbeux.
7. En tant que mainteneur, je veux comprendre la transition pensée/réponse et la gestion du texte cumulatif, afin d’éviter les mélanges et duplications.
8. En tant qu’opérateur, je veux connaître le repli texte brut pour les flux non-TTY ou `SLOPIFY_ANSI_STREAM=0`.
9. En tant que contributeur, je veux que le diff ne contienne que des commentaires, afin de garantir l’absence de changement fonctionnel.

## Implementation Decisions

- La portée est limitée aux commentaires existants du module ciblé, avec enrichissement local uniquement lorsqu’un invariant indispensable manque.
- Tous les commentaires révisés sont en français clair ; les noms techniques et événements ACP sont conservés tels quels.
- Documenter les invariants de cycle de vie, nettoyage par préfixe `runId:nodeId`, restauration, logs, sanitization et streaming append-only.
- Préciser que `streamedTextByNode` extrait le suffixe nouveau lorsque l’adaptateur renvoie un texte cumulatif, sans présenter cela comme une détection générale de tous les formats ACP.
- Préciser que `sanitizeSessionNotification` conserve les messages agent mais remplace le contenu d’une pensée par son type et sa taille ; l’affichage verbeux est distinct.
- Préciser que `MarkdownBlockStream` s’applique au TTY compatible ANSI, tandis que le flux non-TTY ou `SLOPIFY_ANSI_STREAM=0` utilise le texte brut.
- Ne modifier aucun comportement, type, signature, import, nom, structure ou ordre d’opération. Ne modifier aucun autre fichier, test, glossaire ou ADR.

## Testing Decisions

- La seam convenue est l’inspection du diff du fichier ciblé : seules des lignes de commentaires peuvent changer et aucune ligne de code exécutable ne doit être modifiée.
- Exécuter `git diff --check` et la vérification de formatage directement disponible, si applicable.
- Relire l’exactitude des invariants, du français et la conservation des noms techniques et événements ACP.
- Aucun nouveau test n’est requis ou ajouté pour cette modification documentaire.

## Out of Scope

- Toute modification de logique, API, types, signatures, imports, structure, logs, rendu terminal, ANSI, sanitization ou cycle de vie.
- Correction fonctionnelle, refactorisation, documentation de référence et commentaires d’autres fichiers.
- Modification des tests, `CONTEXT.md`, ADR, README, règles de lint ou scripts d’outillage.

## Further Notes

Le vocabulaire canonique est conservé : `Reprise` réutilise un `Agent Checkpoint` sans relancer l’agent ; `Réparation` déclenche un nouveau tour dans la même sandbox ; `Cancellation` termine un Sandbox Run sans décision explicite de `Promotion` ou de `Rejection`. Aucun nouveau terme ni nouvelle décision de domaine n’est introduit.
