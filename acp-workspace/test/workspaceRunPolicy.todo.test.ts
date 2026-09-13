import test from 'node:test';

test.todo("workspaceRunPolicy — handoff hors scratch", function testerWorkspaceRunPolicyHandoffHorsScratch() {
  // TODO : Vérifier le refus d'une référence qui quitte .scratch, sans lire le fichier extérieur.
});

test.todo("workspaceRunPolicy — handoff vers fichier non Markdown", function testerWorkspaceRunPolicyHandoffVersFichierNonMarkdown() {
  // TODO : Vérifier qu'un fichier d'un autre format ne compte pas comme référence de documentation valide.
});

test.todo("workspaceRunPolicy — minimum de références distinctes", function testerWorkspaceRunPolicyMinimumDeReferencesDistinctes() {
  // TODO : Répéter la même référence et vérifier qu'elle ne satisfait pas artificiellement minimumReferences.
});

test.todo("workspaceRunPolicy — handoff mêlant plusieurs features", function testerWorkspaceRunPolicyHandoffMelantPlusieursFeatures() {
  // TODO : Vérifier le rejet d'une spécification et de tickets provenant de racines différentes.
});

test.todo("workspaceRunPolicy — dossier tickets sans Markdown", function testerWorkspaceRunPolicyDossierTicketsSansMarkdown() {
  // TODO : Vérifier le diagnostic lorsque le dossier issues ne contient aucun ticket Markdown.
});

test.todo("workspaceRunPolicy — Ticket ID dupliqué dans Markdown", function testerWorkspaceRunPolicyTicketIDDupliqueDansMarkdown() {
  // TODO : Vérifier qu'un doublon d'identifiant est refusé avant le lancement des implémentations.
});

test.todo("workspaceRunPolicy — blocker inconnu dans Markdown", function testerWorkspaceRunPolicyBlockerInconnuDansMarkdown() {
  // TODO : Vérifier qu'une dépendance non résolue est signalée plutôt que supprimée silencieusement du graphe.
});

test.todo("workspaceRunPolicy — échec d'un ticket en livraison", function testerWorkspaceRunPolicyEchecDUnTicketEnLivraison() {
  // TODO : Vérifier que les tickets suivants et la revue finale ne démarrent pas après un échec.
});

test.todo("workspaceRunPolicy — pause imprévue d'un sous-pipeline", function testerWorkspaceRunPolicyPauseImprevueDUnSousPipeline() {
  // TODO : Simuler un sous-pipeline implement-ticket en pause et vérifier le diagnostic de livraison.
});

test.todo("workspaceRunPolicy — garde documentation et changement de mode", function testerWorkspaceRunPolicyGardeDocumentationEtChangementDeMode() {
  // TODO : Modifier uniquement le mode d'un fichier de code et vérifier que la garde détecte ce changement.
});

test.todo("workspaceRunPolicy — reprise non prise en charge", function testerWorkspaceRunPolicyRepriseNonPriseEnCharge() {
  // TODO : Vérifier que createWorkspaceRun explique l'absence de backend recover sans démarrer un nouveau run.
});
