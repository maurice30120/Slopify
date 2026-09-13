import test from 'node:test';

test.todo("gitPromotion — intégration sans checkpoint", function testerGitPromotionIntegrationSansCheckpoint() {
  // TODO : Vérifier le diagnostic de integrateAgentCheckpoints lorsqu'aucun checkpoint n'est fourni.
});

test.todo("gitPromotion — checkpoint sans identifiant de commit", function testerGitPromotionCheckpointSansIdentifiantDeCommit() {
  // TODO : Simuler rev-parse vide et vérifier l'arrêt avant tout aperçu ou Promotion.
});

test.todo("gitPromotion — échec de staging du checkpoint", function testerGitPromotionEchecDeStagingDuCheckpoint() {
  // TODO : Simuler git add en échec et vérifier l'absence de commit, fetch et preview.
});

test.todo("gitPromotion — échec de récupération du diff", function testerGitPromotionEchecDeRecuperationDuDiff() {
  // TODO : Simuler une erreur de git diff et vérifier qu'aucun aperçu valide n'est retourné.
});

test.todo("gitPromotion — checkpoints issus de runs différents", function testerGitPromotionCheckpointsIssusDeRunsDifferents() {
  // TODO : Tester la composition de checkpoints aux runId différents et préciser le rejet attendu avant intégration.
});

test.todo("gitPromotion — bases de checkpoints divergentes", function testerGitPromotionBasesDeCheckpointsDivergentes() {
  // TODO : Vérifier qu'une composition de bases incompatibles est rejetée avant mutation du workspace hôte.
});

test.todo("gitPromotion — décision ask sans décideur", function testerGitPromotionDecisionAskSansDecideur() {
  // TODO : Vérifier que la politique ask ne peut pas appliquer un Change Set sans callback de décision.
});

test.todo("gitPromotion — décideur en erreur", function testerGitPromotionDecideurEnErreur() {
  // TODO : Faire rejeter le callback de décision et vérifier que la Promotion n'est jamais exécutée.
});

test.todo("gitPromotion — message de conflit sans fichier identifié", function testerGitPromotionMessageDeConflitSansFichierIdentifie() {
  // TODO : Vérifier le diagnostic de IntegrationConflictError lorsque la liste des fichiers est vide.
});

test.todo("gitPromotion — suppression ciblée des refs périmées", function testerGitPromotionSuppressionCibleeDesRefsPerimees() {
  // TODO : Inspecter les commandes envoyées au faux exécuteur et vérifier qu'elles ciblent seulement les refs fournies.
});

test.todo("gitPromotion — annulation pendant intégration", function testerGitPromotionAnnulationPendantIntegration() {
  // TODO : Annuler le signal entre deux opérations simulées et vérifier qu'aucune Promotion ne suit.
});

test.todo("gitPromotion — échec du nettoyage des refs", function testerGitPromotionEchecDuNettoyageDesRefs() {
  // TODO : Simuler une erreur de suppression et vérifier sa remontée avec le nœud et la tentative concernés.
});
