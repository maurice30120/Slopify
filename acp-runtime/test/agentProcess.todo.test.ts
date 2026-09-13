import test from 'node:test';

test.todo("agentProcess — identifiants distincts", function testerAgentProcessIdentifiantsDistincts() {
  // TODO : Simuler plusieurs lancements et vérifier l'unicité des identifiants sans exécuter de processus réel.
});

test.todo("agentProcess — arguments contenant apostrophes et espaces", function testerAgentProcessArgumentsContenantApostrophesEtEspaces() {
  // TODO : Inspecter la commande transmise au faux spawn Unix et vérifier que les arguments restent littéraux.
});

test.todo("agentProcess — shell de connexion optionnel", function testerAgentProcessShellDeConnexionOptionnel() {
  // TODO : Vérifier la présence de -l seulement pour un shell compatible avec loginShell activé.
});

test.todo("agentProcess — shell non compatible", function testerAgentProcessShellNonCompatible() {
  // TODO : Simuler un shell inconnu et vérifier le repli bash ou sh sans exécuter de shell.
});

test.todo("agentProcess — arrêt d'un agent inconnu", function testerAgentProcessArretDUnAgentInconnu() {
  // TODO : Vérifier que killAgent renvoie false et ne tue aucun autre processus.
});

test.todo("agentProcess — arrêt forcé après SIGTERM", function testerAgentProcessArretForceApresSIGTERM() {
  // TODO : Avec une horloge simulée, vérifier SIGKILL après le délai si le processus ne s'est pas arrêté.
});

test.todo("agentProcess — absence de SIGKILL après sortie", function testerAgentProcessAbsenceDeSIGKILLApresSortie() {
  // TODO : Simuler une sortie avant expiration et vérifier qu'aucun arrêt forcé n'est envoyé.
});

test.todo("agentProcess — observation erreur puis fermeture", function testerAgentProcessObservationErreurPuisFermeture() {
  // TODO : Émettre error puis close et vérifier un seul résultat et le retrait des deux listeners.
});

test.todo("agentProcess — observation fermeture puis erreur", function testerAgentProcessObservationFermeturePuisErreur() {
  // TODO : Émettre close puis vérifier la désinscription du listener error sans déclencher d'erreur non gérée dans le faux processus.
});

test.todo("agentProcess — libération du manager", function testerAgentProcessLiberationDuManager() {
  // TODO : Vérifier que dispose arrête tous les agents et retire ses listeners.
});
