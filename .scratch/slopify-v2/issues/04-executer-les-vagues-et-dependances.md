# 04: Exécuter les vagues et intégrer les dépendances

**Ticket ID:** T04

**What to build:** Un lot mixte Pi/Codex exécute toutes les tâches disponibles en parallèle, intègre leurs réussites puis lance leurs descendants depuis le résultat courant, en conservant la progression des branches indépendantes en cas d’échec.

**Blocked by:** 02 — Exécuter Codex et intégrer une tâche isolée ; 03 — Exécuter Pi avec Mistral, skills et revue parallèle.

**Status:** ready-for-agent

- [ ] Toutes les tâches disponibles d’une vague partent en parallèle sans plafond de concurrence, chacune dans un sandbox distinct.
- [ ] Le scheduler attend toute la vague avant intégration déterministe et recalcul de la frontière.
- [ ] Une tâche dépendante démarre sur le commit intégré courant ; les tâches d’une même vague ont la même base.
- [ ] Un échec bloque ses descendants et laisse avancer les tâches indépendantes ; aucun retry ou changement d’agent implicite.
- [ ] Le bilan comporte les statuts, commits, rapports et blocages de chaque tâche et la branche obtenue.
- [ ] Une tâche finale de vérification dépendante de toutes les implémentations est traitée comme tâche ordinaire ; son échec empêche la réussite globale.

**Public seam:** lancement/état du lot, avec vrai Git et frontière externe d’exécution substituée.

**Validation:** scénario à deux tâches indépendantes et une dépendante, scénario mixte, échec localisé et vérification finale échouée ; tests ciblés et build.
