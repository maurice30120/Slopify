# 04: Exécuter les vagues et intégrer les dépendances

**Ticket ID:** T04

**What to build:** Un lot mixte Pi/Codex exécute toutes les tâches disponibles en parallèle, intègre leurs réussites puis lance leurs descendants depuis le résultat courant, en conservant la progression des branches indépendantes en cas d’échec.

**Blocked by:** 02 — Exécuter Codex et intégrer une tâche isolée ; 03 — Exécuter Pi avec Mistral, skills et revue parallèle.

**Status:** resolved

- [x] Toutes les tâches disponibles d’une vague partent en parallèle sans plafond de concurrence, chacune dans un sandbox distinct.
- [x] Le scheduler attend toute la vague avant intégration déterministe et recalcul de la frontière.
- [x] Une tâche dépendante démarre sur le commit intégré courant ; les tâches d’une même vague ont la même base.
- [x] Un échec bloque ses descendants et laisse avancer les tâches indépendantes ; aucun retry ou changement d’agent implicite.
- [x] Le bilan comporte les statuts, commits, rapports et blocages de chaque tâche et la branche obtenue.
- [x] Une tâche finale de vérification dépendante de toutes les implémentations est traitée comme tâche ordinaire ; son échec empêche la réussite globale.

**Public seam:** lancement/état du lot, avec vrai Git et frontière externe d’exécution substituée.

**Validation:** scénario à deux tâches indépendantes et une dépendante, scénario mixte, échec localisé et vérification finale échouée ; tests ciblés et build.

**Implementation:** feature/slopify-v2-t04 ; base c794907a9. Tips 85ff31a34, 5ffc13f4b.

**Acceptance evidence:** public `TaskBatchService` tests in slopify/test/taskWaves.test.ts exercise wave execution with only the sbx subprocess boundary substituted and real Git clones/branches. Six tests verify parallel mixed-wave launch, wait-then-integrate per wave with same base per wave, cross-wave dependent base on the updated integrated commit, failure blocking only descendants, no implicit retry/agent change, exposed per-task statuses/commits/reports/blockers/integration branch, and a failed final verification task preventing global success. TDD and review evidence: /private/tmp/slopify-v2-agent-notes/t04.md.

**Integration acceptance:** merged by the integration branch after full workspace build and 95/95 slopify tests. Standards/Spec review ran as two real parallel Pi subagents (exit 0, artifacts in /private/tmp/slopify-v2-agent-notes/pi-sessions/subagent-artifacts); P1 cross-wave base test gap fixed in 5ffc13f4b. Inherited WIP also introduced conflict/suspension types that T06 will build on; T04 tests do not claim conflict behavior. Notes: /private/tmp/slopify-v2-agent-notes/merges.md.
