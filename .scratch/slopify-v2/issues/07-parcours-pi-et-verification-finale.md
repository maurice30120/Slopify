# 07: Relier le parcours Pi et vérifier la V2 complète

**Ticket ID:** T07

**What to build:** Depuis sa conversation, Pi peut préparer le lot complet depuis fichiers ou issues, suivre le run jusqu’au bilan final et présenter une branche vérifiée ; le parcours est documenté et exercé avec Pi et Codex réels.

**Blocked by:** 06 — Suspendre et résoudre les conflits sur action explicite.

**Status:** resolved-with-limitation

- [x] Le guide du coordinateur et les exemples couvrent fichiers locaux et issues, références préservées, prérequis externes bloquants et attribution Pi/Codex.
- [x] Le contexte contient les interfaces de test approuvées et les prompts adaptés sans recopier les instructions des skills officiels.
- [x] Pi ajoute une tâche finale dépendant de toutes les implémentations, qui exécute typechecking, suite complète et revue Standards/Spec depuis la base du run.
- [ ] Les reviewers ont accès aux traces réelles de validations, TDD et délégation ; les preuves manquantes et écarts de processus sont signalés.
- [ ] Un échec final est présenté et sa correction exige un nouveau lot explicitement autorisé basé sur la branche obtenue.
- [x] Le bilan donne branche, tâches, commits, rapports, ressources retenues et interventions ; récupération hôte et clôture des tickets restent explicites.
- [x] Les docs/ADR de la cible V2 sont alignés sur Pi/Codex ; les essais Vibe restent historiques.
- [ ] Le build et toute la suite passent sur le résultat combiné ; un smoke réel mixte avec dépendance et vérification finale confirme le parcours, ses preuves et ses limites.

**Public seam:** CLI publique et API de lot, puis exécutions Docker réelles sur dépôts jetables.

**Validation:** `npm run build`, `npm test`, smoke Pi/Codex enregistré, revue finale de la branche d’intégration contre la base et la spec ; aucune preuve reconstruite à partir des seuls commits.

**Integration acceptance:** merged no-ff into feature/slopify-v2; full workspace build and 117/117 slopify tests pass. Delivered: coordinator guide (docs/agents/coordinator-pi.md), ADR 0011 and historical-ADR disclaimers (Vibe out of V2 target; Pi coordinator; Pi/Codex only), resume fixes for stale running tasks (8c6039429) verified by real smoke behavior. REAL smoke 607fb7f8 (store /private/tmp/slopify-v2-smoke-store): parallel wave launch in real Docker sandboxes, task-add completed by real Pi with new attempt identity after explicit resume, integrated literals verified on the dedicated branch, honest Codex failure (account limitation: no supported model with ChatGPT account) with retained sandbox/logs, descendants correctly blocked, host copy preserved. Box 8 is UNCHECKED by design: the completed success path (total + final verification task + in-sandbox review) could not run because the Codex account is currently limited; a re-run of the smoke batch requires explicit authorization once Codex is available again. Implementer-level Standards/Spec review of the T07 diff was not performed by the implementer (marked box 4 unchecked honestly); the orchestrator's final overall review of the integration branch against dbb62124b and the spec covers it and is recorded in merges.md. Notes: /private/tmp/slopify-v2-agent-notes/merges.md.
