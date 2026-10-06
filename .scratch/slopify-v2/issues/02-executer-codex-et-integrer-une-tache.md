# 02: Exécuter Codex et intégrer une tâche isolée

**Ticket ID:** T02

**What to build:** Un lot d’une tâche Codex produit un checkpoint et une branche d’intégration récupérable, avec logs et compte rendu, sans changer la branche ni les fichiers de l’utilisateur.

**Blocked by:** 01 — Valider et figer le lot complet.

**Status:** ready-for-agent

- [ ] Le sandbox part du commit choisi dans une copie privée, avec un contexte figé lisible et les commits de comparaison explicites.
- [ ] Codex reçoit son prompt intact et les skills officiels installés via `sbx skills` en lecture seule, sans mise à jour implicite.
- [ ] La tâche suit le parcours `implement` avec commit provisoire avant revue, validations et compte rendu.
- [ ] Commit/checkpoint, stdout/stderr et rapport sont durables avant nettoyage ; les erreurs conservent le sandbox et son diagnostic.
- [ ] Le résultat est intégré dans une branche dédiée accessible depuis le dépôt utilisateur ; aucun checkout ni promotion hôte.
- [ ] Les modifications hôtes non commités sont préservées et leur exclusion du point de départ est explicite.

**Public seam:** lancement/état du lot ; exécuteur externe de sous-processus pour le contrat Docker.

**Validation:** test d’intégration sur vrai dépôt Git temporaire avec exécuteur Docker substitué, build et tests ciblés ; scénario succès/échec/nettoyage vérifié.
