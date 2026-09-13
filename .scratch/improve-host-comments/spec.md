## Problem Statement

Les commentaires existants du module hôte de la CLI sont utiles mais inégaux : certains expliquent une décision non évidente en français, tandis qu’un commentaire reste en anglais et que plusieurs invariants importants ne sont pas formulés avec assez de précision. La lecture du module ne permet pas toujours de comprendre immédiatement le cycle de vie d’un run, la raison du nettoyage, la différence entre reprise et relance, ni les garanties particulières de la journalisation et du streaming.

Cette ambiguïté augmente le risque qu’une évolution future rompe la reprise d’un run en pause, conserve un état périmé après un résultat terminal, persiste par erreur le contenu d’une pensée d’agent ou duplique le texte cumulatif affiché dans le terminal.

## Solution

Réviser tous les commentaires déjà présents dans le module hôte de la CLI afin qu’ils soient rédigés en français clair, concis et techniquement exact. Les commentaires doivent privilégier les invariants et les raisons non évidentes plutôt que décrire ce que le code montre déjà.

La révision doit notamment rendre explicites :

- le maintien en mémoire des runs en pause pour permettre leur reprise, et le retrait des runs terminaux ainsi que de leur état associé ;
- le rôle des journaux de run et de nœud, leur nettoyage et le filtrage du diagnostic asynchrone de fin de processus ;
- la séparation entre le contenu affiché en mode verbeux et le contenu persistant, en particulier pour `agent_thought_chunk` ;
- la transition entre pensées et réponses, la détection des deltas face au texte cumulatif et le rendu Markdown par blocs sur TTY ;
- les comportements de repli sur texte brut pour les flux non-TTY ou lorsque `SLOPIFY_ANSI_STREAM=0`.

Les noms techniques, les événements ACP et les noms de variables d’environnement restent inchangés. Le comportement, les types, les signatures et la structure du code doivent être préservés strictement.

## User Stories

1. En tant que mainteneur, je veux comprendre pourquoi un run en pause reste attaché à son runtime afin de préserver ses sessions lors d’une Reprise.
2. En tant que mainteneur, je veux comprendre pourquoi un résultat terminal déclenche le nettoyage du runtime, des journaux et des caches afin d’éviter les états périmés et les fuites mémoire.
3. En tant que développeur, je veux distinguer la Reprise d’un run checkpointé d’une Réparation ou d’une nouvelle tentative afin de ne pas documenter ni modifier par erreur le mauvais parcours de récupération.
4. En tant que développeur, je veux connaître les conditions qui permettent de restaurer un runtime depuis le run store afin de comprendre les statuts `paused` et `running` acceptés.
5. En tant que mainteneur, je veux savoir comment les événements ACP sont associés à un nœud agent ou à un run afin de préserver la cohérence des journaux lors d’une évolution du traitement d’événements.
6. En tant que développeur, je veux comprendre le rôle de `activeAgentNodes` afin de savoir comment les logs d’un agent sont rattachés au nœud actif puis détachés à sa terminaison.
7. En tant qu’opérateur, je veux savoir pourquoi le message de fin asynchrone d’un agent peut être conservé dans les logs sans être affiché dans le terminal afin de ne pas le confondre avec un crash.
8. En tant que développeur, je veux comprendre la différence entre les logs de run et les logs propres à un nœud afin de diagnostiquer une exécution sans perdre le contexte global.
9. En tant que développeur, je veux savoir pourquoi le contenu d’une pensée d’agent est assaini avant persistance, alors qu’il peut encore être affiché en mode verbeux, afin de préserver cette frontière de confidentialité.
10. En tant que développeur, je veux comprendre la distinction entre `agent_thought_chunk` et `agent_message_chunk` afin de préserver le filtrage et l’affichage propres à chaque phase.
11. En tant que mainteneur, je veux savoir pourquoi le tampon de streaming est vidé lors d’un changement de phase afin que l’en-tête « réfléchit » ou « répond » ne se mélange pas au texte précédent.
12. En tant que développeur, je veux comprendre pourquoi certains adaptateurs ACP envoient un delta et d’autres le texte cumulatif afin d’éviter les duplications dans l’affichage.
13. En tant que mainteneur, je veux savoir dans quelles conditions `MarkdownBlockStream` est utilisé afin de préserver le rendu par blocs sur TTY et le texte brut dans les autres flux.
14. En tant qu’opérateur, je veux connaître l’effet de `SLOPIFY_ANSI_STREAM=0` afin de pouvoir désactiver le rendu ANSI sans modifier le contenu streamé.
15. En tant que contributeur, je veux que tous les commentaires révisés utilisent un français clair tout en conservant les noms techniques et événements ACP afin de maintenir un vocabulaire cohérent avec le domaine du projet.
16. En tant que mainteneur, je veux que la modification soit limitée aux commentaires afin de pouvoir vérifier rapidement qu’aucun comportement, type, API ou flux de contrôle n’a changé.

## Implementation Decisions

- La portée couvre tous les commentaires actuellement présents dans le module hôte ciblé, y compris le commentaire JSDoc de `CliPipelineHost`, les commentaires du logger, du streaming, de l’assainissement des notifications et du filtre de fin de processus.
- Les commentaires sont réécrits en français clair. Les noms `CliPipelineHost`, `PipelineRuntime`, `PipelineRunLog`, `MarkdownBlockStream`, `agent_thought_chunk`, `agent_message_chunk`, `SLOPIFY_ANSI_STREAM` et les autres termes techniques restent tels quels.
- Les commentaires doivent expliquer les invariants et les raisons non évidentes : attachement pendant la pause, nettoyage à l’état terminal, restauration depuis un snapshot, rattachement des logs au nœud actif, non-persistance du raisonnement et rendu append-only par blocs.
- La documentation du streaming doit conserver la distinction suivante : un TTY compatible ANSI utilise le rendu Markdown par blocs terminés ; un flux non-TTY ou la valeur `SLOPIFY_ANSI_STREAM=0` utilise le texte brut. Le rendu n’effectue pas de déplacement ni d’effacement du curseur.
- La documentation doit préciser que `streamedTextByNode` compare le texte entrant au dernier texte reçu pour ne rendre que le suffixe nouveau lorsque l’adaptateur renvoie un texte cumulatif. Elle ne doit pas présenter cette logique comme une détection générale de tous les formats ACP.
- La documentation doit préciser que `sanitizeSessionNotification` conserve les messages agent dans les logs, mais remplace le contenu d’une pensée par ses informations de type et de taille ; l’affichage verbeux suit un chemin distinct.
- La documentation doit préciser que le diagnostic `Agent "…" exited (code=…, signal=SIGTERM)` peut être une libération normale lors d’une pause : il est conservé pour le diagnostic mais filtré de l’affichage terminal afin de ne pas être confondu avec un échec.
- La documentation du nettoyage doit expliquer que les caches indexés par `runId:nodeId` sont supprimés par préfixe pour le run concerné, et que l’état d’un run en pause n’est pas nettoyé prématurément.
- Aucun nouveau JSDoc exhaustif, commentaire de remplissage ou fichier de documentation séparé ne doit être ajouté. Un enrichissement local est acceptable uniquement lorsqu’il clarifie directement un commentaire existant ou un invariant indispensable à sa compréhension.
- Seul le texte des commentaires peut changer. Les imports, instructions, expressions, types, signatures, noms, niveaux d’imbrication et ordre des opérations restent strictement identiques.
- Aucun changement ne doit être apporté à un autre fichier, aux tests, au `CONTEXT.md` ou aux ADR. Les termes de domaine existants sont consommés tels quels ; aucun nouveau terme de glossaire n’est introduit.

## Testing Decisions

- La validation porte d’abord sur l’inspection du diff : il doit montrer uniquement des modifications de commentaires dans le module ciblé, sans changement de comportement, de type ou de structure.
- Les contrôles légers déjà disponibles peuvent être exécutés, notamment la vérification des espaces et erreurs de patch (`git diff --check`) et le contrôle TypeScript ciblé s’il est directement disponible dans le dépôt.
- Aucun nouveau test ne doit être créé. Les tests existants ne nécessitent pas d’extension pour une modification limitée aux commentaires.
- La relecture vérifie l’exactitude des invariants de cycle de vie, du nettoyage, de la Reprise et de la journalisation, ainsi que la cohérence du français et la conservation exacte des noms techniques et événements ACP.

## Out of Scope

- Toute modification de logique, d’API, de types, de signatures, d’imports ou de structure du code.
- L’ajout d’une documentation exhaustive des exports, méthodes privées, helpers ou constantes qui ne disposent pas déjà d’un commentaire à réviser.
- La traduction ou la révision de commentaires situés dans d’autres fichiers.
- La modification ou l’ajout de tests, de règles de lint, de scripts de vérification ou d’outillage documentaire.
- La modification des logs produits, du rendu terminal, du comportement ANSI, des règles de sanitization ou du cycle de vie des runs.
- La mise à jour du `CONTEXT.md`, d’un ADR, du README ou de toute documentation utilisateur.

## Further Notes

Le vocabulaire canonique du dépôt doit être respecté lorsqu’il s’applique : `Reprise` désigne la réutilisation d’un `Agent Checkpoint` sans relancer l’agent ; `Réparation` désigne un nouveau tour dans la même sandbox ; `Cancellation` désigne la fin sans décision de `Promotion` ou de `Rejection`. Ces distinctions doivent rester compatibles avec les décisions documentées par les ADR sur les logs de run, le rendu du Markdown streamé et la restauration checkpointée.

La spécification est volontairement limitée à la qualité et à la précision des commentaires existants. La validation finale doit confirmer que le diff reste strictement documentaire.
