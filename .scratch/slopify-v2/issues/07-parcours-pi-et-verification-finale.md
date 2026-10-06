# 07: Relier le parcours Pi et vérifier la V2 complète

**Ticket ID:** T07

**What to build:** Depuis sa conversation, Pi peut préparer le lot complet depuis fichiers ou issues, suivre le run jusqu’au bilan final et présenter une branche vérifiée ; le parcours est documenté et exercé avec Pi et Codex réels.

**Blocked by:** 06 — Suspendre et résoudre les conflits sur action explicite.

**Status:** claimed

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
