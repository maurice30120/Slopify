import test from 'node:test';

test.todo("acpRunner — notifications d'une autre session", function testerAcpRunnerNotificationsDUneAutreSession() {
  // TODO : Vérifier que les messages dont sessionId diffère ne contaminent ni le texte ni les notifications de la session courante.
});

test.todo("acpRunner — pensées exclues du résultat", function testerAcpRunnerPenseesExcluesDuResultat() {
  // TODO : Envoyer pensées et réponses puis vérifier que seules les réponses textuelles constituent le texte final.
});

test.todo("acpRunner — réponses non textuelles", function testerAcpRunnerReponsesNonTextuelles() {
  // TODO : Vérifier qu'un bloc image ou ressource n'est pas concaténé au texte final.
});

test.todo("acpRunner — finalisation avec contexte exact", function testerAcpRunnerFinalisationAvecContexteExact() {
  // TODO : Vérifier la transmission de connected et sessionId au callback finalize ainsi que la conservation de son résultat.
});

test.todo("acpRunner — finalisation en erreur", function testerAcpRunnerFinalisationEnErreur() {
  // TODO : Faire rejeter finalize et vérifier la propagation de l'erreur et la libération de la connexion.
});

test.todo("acpRunner — authentification retentée une seule fois", function testerAcpRunnerAuthentificationRetenteeUneSeuleFois() {
  // TODO : Simuler deux erreurs auth-required successives et vérifier qu'une seule authentification est proposée.
});

test.todo("acpRunner — annulation demandée par le protocole", function testerAcpRunnerAnnulationDemandeeParLeProtocole() {
  // TODO : Simuler stopReason cancelled et vérifier RunAbortedError sans finalisation.
});

test.todo("acpRunner — échec de cancel pendant annulation", function testerAcpRunnerEchecDeCancelPendantAnnulation() {
  // TODO : Faire échouer cancel et vérifier que la connexion est libérée et le diagnostic journalisé.
});

test.todo("acpRunner — listeners retirés après échec", function testerAcpRunnerListenersRetiresApresEchec() {
  // TODO : Vérifier que les abonnements au signal et aux notifications sont retirés après une erreur.
});

test.todo("acpRunner — annulation concurrente avec finally", function testerAcpRunnerAnnulationConcurrenteAvecFinally() {
  // TODO : Faire coïncider une annulation et la fin du prompt puis vérifier l'unicité de dispose.
});
