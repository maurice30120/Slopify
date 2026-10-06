# 07: Relier le parcours Pi et vérifier la V2 complète

**Ticket ID:** T07

**What to build:** Depuis sa conversation, Pi peut préparer le lot complet depuis fichiers ou issues, suivre le run jusqu’au bilan final et présenter une branche vérifiée ; le parcours est documenté et exercé avec Pi et Codex réels.

**Blocked by:** 06 — Suspendre et résoudre les conflits sur action explicite.

**Status:** resolved

- [x] Le guide du coordinateur et les exemples couvrent fichiers locaux et issues, références préservées, prérequis externes bloquants et attribution Pi/Codex.
- [x] Le contexte contient les interfaces de test approuvées et les prompts adaptés sans recopier les instructions des skills officiels.
- [x] Pi ajoute une tâche finale dépendant de toutes les implémentations, qui exécute typechecking, suite complète et revue Standards/Spec depuis la base du run.
- [x] Les reviewers ont accès aux traces réelles de validations, TDD et délégation ; les preuves manquantes et écarts de processus sont signalés.
- [x] Un échec final est présenté et sa correction exige un nouveau lot explicitement autorisé basé sur la branche obtenue.
- [x] Le bilan donne branche, tâches, commits, rapports, ressources retenues et interventions ; récupération hôte et clôture des tickets restent explicites.
- [x] Les docs/ADR de la cible V2 sont alignés sur Pi/Codex ; les essais Vibe restent historiques.
- [x] Le build et toute la suite passent sur le résultat combiné ; un smoke réel mixte avec dépendance et vérification finale confirme le parcours, ses preuves et ses limites.

**Public seam:** CLI publique et API de lot, puis exécutions Docker réelles sur dépôts jetables.

**Validation:** `npm run build`, `npm test`, smoke Pi/Codex enregistré, revue finale de la branche d’intégration contre la base et la spec ; aucune preuve reconstruite à partir des seuls commits.

**Integration acceptance:** Full workspace build and 126/126 Slopify tests pass. Real initial mixed run 607fb7f8 exercised concurrent Pi/Codex launch, explicit resume, checkpoint reuse, dependent total and final review from the original base. That review rejected fixture deviations; its historical process-zero false success led to fix 84c119b. Distinct correction batch f487d3ad was explicitly submitted from the obtained branch: Codex repair then dependent Pi final verification, both real explicit succeeded verdicts without failure diagnostics. Final fixture commit 343d2e1bd7e0dfa4d2d62504858ece37afd54fb3, 8/8 node:test cases and literal checks; original metadata restored. Standards/Spec reviewers ran with exit 0 and no remaining violations. Observer checks branch/checkpoint ancestry, frozen context, actual cleanup and host preservation. Missing/model-process evidence remains honestly qualified. Complete evidence and limitations: [finish-verification.md](../finish-verification.md).
