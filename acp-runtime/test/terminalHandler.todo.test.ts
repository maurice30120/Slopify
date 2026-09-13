import test from 'node:test';

test.todo("terminalHandler — répertoire de travail extérieur", function testerTerminalHandlerRepertoireDeTravailExterieur() {
  // TODO : Vérifier que createTerminal refuse un cwd hors workspace avant d'appeler le faux spawn.
});

test.todo("terminalHandler — variables interdites demandées", function testerTerminalHandlerVariablesInterditesDemandees() {
  // TODO : Vérifier que les variables interdites fournies par l'agent ne remplacent pas celles héritées de l'hôte.
});

test.todo("terminalHandler — sorties stdout et stderr entrelacées", function testerTerminalHandlerSortiesStdoutEtStderrEntrelacees() {
  // TODO : Émettre des buffers sur les deux flux du faux processus et vérifier l'ordre de la sortie agrégée.
});

test.todo("terminalHandler — sortie disponible avant fin du processus", function testerTerminalHandlerSortieDisponibleAvantFinDuProcessus() {
  // TODO : Lire terminalOutput pendant l'exécution et vérifier l'absence de exitStatus avant close.
});

test.todo("terminalHandler — limite de sortie nulle", function testerTerminalHandlerLimiteDeSortieNulle() {
  // TODO : Vérifier qu'une limite de zéro ne conserve aucun contenu et signale la troncature.
});

test.todo("terminalHandler — limite de sortie avec caractères multioctets", function testerTerminalHandlerLimiteDeSortieAvecCaracteresMultioctets() {
  // TODO : Vérifier que la troncature respecte la limite en octets sans couper un caractère Unicode.
});

test.todo("terminalHandler — arrêt d'un terminal déjà terminé", function testerTerminalHandlerArretDUnTerminalDejaTermine() {
  // TODO : Vérifier que killTerminal ne renvoie pas de signal à un processus déjà sorti.
});

test.todo("terminalHandler — attente après erreur de processus", function testerTerminalHandlerAttenteApresErreurDeProcessus() {
  // TODO : Simuler un événement error et vérifier que waitForTerminalExit ne reste pas suspendu.
});

test.todo("terminalHandler — identifiant terminal inconnu", function testerTerminalHandlerIdentifiantTerminalInconnu() {
  // TODO : Vérifier le diagnostic pour output, wait, kill et release avec un identifiant inexistant.
});

test.todo("terminalHandler — libération de tous les terminaux", function testerTerminalHandlerLiberationDeTousLesTerminaux() {
  // TODO : Vérifier que dispose arrête les terminaux actifs, ignore ceux terminés et vide le registre.
});
