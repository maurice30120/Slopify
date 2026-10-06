# 02: Exécuter Codex et intégrer une tâche isolée

**Ticket ID:** T02

**What to build:** Un lot d’une tâche Codex produit un checkpoint et une branche d’intégration récupérable, avec logs et compte rendu, sans changer la branche ni les fichiers de l’utilisateur.

**Blocked by:** 01 — Valider et figer le lot complet.

**Status:** resolved

- [x] Le sandbox part du commit choisi dans une copie privée, avec un contexte figé lisible et les commits de comparaison explicites.
- [x] Codex reçoit son prompt intact et les skills officiels installés via `sbx skills` en lecture seule, sans mise à jour implicite.
- [x] La tâche suit le parcours `implement` avec commit provisoire avant revue, validations et compte rendu.
- [x] Commit/checkpoint, stdout/stderr et rapport sont durables avant nettoyage ; les erreurs conservent le sandbox et son diagnostic.
- [x] Le résultat est intégré dans une branche dédiée accessible depuis le dépôt utilisateur ; aucun checkout ni promotion hôte.
- [x] Les modifications hôtes non commités sont préservées et leur exclusion du point de départ est explicite.

**Public seam:** lancement/état du lot ; exécuteur externe de sous-processus pour le contrat Docker.

**Validation:** test d’intégration sur vrai dépôt Git temporaire avec exécuteur Docker substitué, build et tests ciblés ; scénario succès/échec/nettoyage vérifié.

**Verification:** public batch/Docker seam tests in taskDocker plus taskBatch; real Git temporary clones, original prompt and private base assertions, live logs/resource registration, checkpoint bundle and native reviewer rollouts before cleanup, provider/subagent failures retained. Build and full npm test passed; actual mixed Docker smoke belongs to T07.

**Integration acceptance:** feature/slopify-v2-t02 `39bfebcb5` merged by `d0d97a0bfaf63ad94ec29c1ac0dc2a3716fbf32f`; `npm ci --offline`, `npm run build`, and public `taskDocker` + `taskBatch` tests pass (15/15, including seven Codex execution cases). The harness supplies the official implement workflow and review baselines; automated tests prove execution/context/durability contracts. Actual model compliance and mixed Docker smoke are verified under T07, rather than inferred from the test executor report. Notes: `/private/tmp/slopify-v2-agent-notes/merges.md`.
