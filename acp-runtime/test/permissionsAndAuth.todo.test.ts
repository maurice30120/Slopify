import test from 'node:test';

test.todo("permissionsAndAuth — permission avec options vides", function testerPermissionsAndAuthPermissionAvecOptionsVides() {
  // TODO : Vérifier une annulation propre quand aucune option de permission n'est annoncée, y compris en auto-approbation.
});

test.todo("permissionsAndAuth — préférence allow_once", function testerPermissionsAndAuthPreferenceAllowOnce() {
  // TODO : Présenter allow_always avant allow_once et vérifier le choix de allow_once en mode auto-approbation.
});

test.todo("permissionsAndAuth — sélection de permission inconnue", function testerPermissionsAndAuthSelectionDePermissionInconnue() {
  // TODO : Faire retourner un libellé absent des options et vérifier l'annulation.
});

test.todo("permissionsAndAuth — erreur UI de permission", function testerPermissionsAndAuthErreurUIDePermission() {
  // TODO : Simuler une erreur hors timeout dans ui.select et vérifier sa propagation.
});

test.todo("permissionsAndAuth — authentification sans méthode", function testerPermissionsAndAuthAuthentificationSansMethode() {
  // TODO : Vérifier que runAuthFlow arrête l'agent et explique l'absence de méthode annoncée.
});

test.todo("permissionsAndAuth — refus explicite d'authentification", function testerPermissionsAndAuthRefusExpliciteDAuthentification() {
  // TODO : Faire refuser la confirmation et vérifier l'arrêt sans appel authenticate.
});

test.todo("permissionsAndAuth — annulation du choix de méthode", function testerPermissionsAndAuthAnnulationDuChoixDeMethode() {
  // TODO : Faire retourner une sélection vide et vérifier l'arrêt de l'agent.
});

test.todo("permissionsAndAuth — arrêt du processus pendant authentification", function testerPermissionsAndAuthArretDuProcessusPendantAuthentification() {
  // TODO : Simuler une sortie pendant authenticate et vérifier le diagnostic de processus plutôt qu'un succès.
});

test.todo("permissionsAndAuth — classification des erreurs étrangères", function testerPermissionsAndAuthClassificationDesErreursEtrangeres() {
  // TODO : Tester null, primitives et codes RPC sans rapport pour éviter les faux positifs de isAuthRequiredError.
});

test.todo("permissionsAndAuth — garde RunAbortedError", function testerPermissionsAndAuthGardeRunAbortedError() {
  // TODO : Vérifier instance locale, Error avec name correspondant, Error ordinaire et objet non Error.
});
