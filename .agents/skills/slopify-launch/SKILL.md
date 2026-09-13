---
name: slopify-launch
description: "Piloter Slopify depuis une demande utilisateur : grilling, sélection d'un pipeline, lancement et explication de la progression des runs."
---

## Lancer

Mener systématiquement une session de grilling avant tout nouveau lancement Slopify : une question de décision à la fois, accompagnée d'une recommandation. Chercher les faits dans le dépôt. Un entretien déjà confirmé dans la conversation peut servir de session ; ne pas le recommencer.

Produire un brief comprenant objectif, périmètre, contraintes, critères d'acceptation et décisions. Obtenir sa confirmation explicite avant exécution. Le brief exprime les décisions utilisateur ; une éventuelle étape de spécification apporte ensuite les détails techniques.

Consulter `slopify catalog --json --cwd <workspace>` une fois avant le lancement. Les intentions, étapes et capacités vivent dans `.acp/pipeline-catalog.json`. Choisir parmi les pipelines disponibles le plus léger couvrant clairement le besoin, selon la clarté, l'étendue, la décomposition et la validation nécessaire. Ne pas composer de pipeline ni ajouter de classifieur à Slopify.

Respecter un pipeline explicitement demandé. Annoncer le choix et une justification courte. Demander une nouvelle confirmation seulement si le choix implique un changement important de coût, durée ou parallélisme, ou si des options également adaptées nécessitent une décision utilisateur. Ne pas interpréter la confirmation du brief comme une autorisation de promotion.

Écrire un fichier de brief conforme à [launch-brief.md](references/launch-brief.md), puis appeler `slopify run <id> --brief <file> --cwd <workspace> --json`. Conserver l'identifiant du run. Utiliser des arguments séparés ou un échappement shell approprié ; ne pas interpoler le texte utilisateur comme du code shell.

Si le catalogue est absent ou invalide, arrêter avec le diagnostic. Un pipeline explicitement demandé peut être lancé via la commande historique `run <id> <brief confirmé>` seulement si `slopify list --json` confirme son existence ; informer que la sélection ne peut pas être liée à une version du catalogue. Ne jamais choisir un pipeline de repli silencieusement.

## Expliquer un run

Lire `slopify inspect <run-id> --json --cwd <workspace>`. Ce snapshot est la source canonique. Expliquer les actions concrètes, cibles et derniers résultats, une ligne concise par nœud actif. Utiliser les artefacts et diagnostics pour les résultats terminés et les blocages. La source `agent` est une déclaration d'activité, la source `runtime` un fait observable. Ne pas présenter une intention ou une prochaine étape comme un travail accompli.

Exemple : « Ajoute le contrôle d'expiration dans TokenValidator.ts ; les tests ciblés sont en cours. » Ne le dire que si les données le permettent. Mentionner l'horodatage si la progression est ancienne ; un heartbeat ne prouve aucune avancée. Pour approfondir, consulter `slopify logs <run-id> --json`.

## Superviser

Proposer uniquement les actions exposées par l'inspection, avec leurs préconditions. Exécuter `resume`, `cancel` ou `retry <run-id> <node-id>` seulement sur demande explicite de l'utilisateur. Une erreur ou une absence d'activité n'autorise aucune relance automatique. Ne pas modifier directement le store. Une commande occupée doit être gérée dans son terminal propriétaire avant une reprise depuis un autre processus.
