import test from 'node:test';

test.todo("sessions — listener enregistré deux fois", function testerSessionsListenerEnregistreDeuxFois() {
  // TODO : Vérifier qu'ajouter deux fois le même callback n'entraîne qu'une notification.
});

test.todo("sessions — retrait d'un listener absent", function testerSessionsRetraitDUnListenerAbsent() {
  // TODO : Vérifier que retirer un callback jamais enregistré ne perturbe pas les autres.
});

test.todo("sessions — dispose répété des notifications", function testerSessionsDisposeRepeteDesNotifications() {
  // TODO : Vérifier qu'après plusieurs dispose aucun ancien callback ne reçoit d'événement.
});

test.todo("sessions — création de session en erreur", function testerSessionsCreationDeSessionEnErreur() {
  // TODO : Simuler un rejet de newSession et vérifier sa propagation et la libération de la connexion.
});

test.todo("sessions — prompt interrompu par arrêt agent", function testerSessionsPromptInterrompuParArretAgent() {
  // TODO : Simuler la sortie du processus pendant un prompt et vérifier la terminaison du run sans attente infinie.
});

test.todo("sessions — annulation avant connexion", function testerSessionsAnnulationAvantConnexion() {
  // TODO : Vérifier le comportement d'AcpRunner avec un signal déjà annulé, sans opération distante inutile.
});

test.todo("sessions — suppression de connexion inconnue", function testerSessionsSuppressionDeConnexionInconnue() {
  // TODO : Vérifier que removeConnection reste sans effet sur les connexions existantes lorsqu'un identifiant est absent.
});

test.todo("sessions — double libération de connexion", function testerSessionsDoubleLiberationDeConnexion() {
  // TODO : Vérifier que les ressources associées à une connexion ne sont pas libérées deux fois.
});
