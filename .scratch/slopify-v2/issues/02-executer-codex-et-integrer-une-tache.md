# 02: Exécuter Codex et intégrer une tâche isolée

**Ticket ID:** T02

**What to build:** Un lot d’une tâche Codex produit un checkpoint et une branche d’intégration récupérable, avec logs et compte rendu, sans changer la branche ni les fichiers de l’utilisateur.

**Blocked by:** 01 — Valider et figer le lot complet.

**Status:** claimed — T02 implementer

- [x] Le sandbox part du commit choisi dans une copie privée, avec un contexte figé lisible et les commits de comparaison explicites.
- [x] Codex reçoit son prompt intact et les skills officiels installés via `sbx skills` en lecture seule, sans mise à jour implicite.
- [x] La tâche suit le parcours `implement` avec commit provisoire avant revue, validations et compte rendu.
- [x] Commit/checkpoint, stdout/stderr et rapport sont durables avant nettoyage ; les erreurs conservent le sandbox et son diagnostic.
- [x] Le résultat est intégré dans une branche dédiée accessible depuis le dépôt utilisateur ; aucun checkout ni promotion hôte.
- [x] Les modifications hôtes non commités sont préservées et leur exclusion du point de départ est explicite.

**Public seam:** lancement/état du lot ; exécuteur externe de sous-processus pour le contrat Docker.

**Validation:** test d’intégration sur vrai dépôt Git temporaire avec exécuteur Docker substitué, build et tests ciblés ; scénario succès/échec/nettoyage vérifié.

**Verification:** public batch/Docker seam tests in taskDocker plus taskBatch; real Git temporary clones, original prompt and private base assertions, live logs/resource registration, checkpoint bundle and native reviewer rollouts before cleanup, provider/subagent failures retained. Build and full npm test passed; actual mixed Docker smoke belongs to T07.
