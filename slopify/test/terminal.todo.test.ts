import test from 'node:test';

test.todo("terminal — sélection sans options", function testerTerminalSelectionSansOptions() {
  // TODO : Vérifier que select retourne undefined sans demander de saisie lorsque la liste est vide.
});

test.todo("terminal — sélection par numéro", function testerTerminalSelectionParNumero() {
  // TODO : Vérifier que les numéros 1 et N sélectionnent respectivement la première et la dernière option.
});

test.todo("terminal — sélection annulée", function testerTerminalSelectionAnnulee() {
  // TODO : Vérifier qu'une saisie vide annule le choix sans sélectionner implicitement la première option.
});

test.todo("terminal — sélection hors limites", function testerTerminalSelectionHorsLimites() {
  // TODO : Vérifier qu'un index nul, négatif ou supérieur au nombre d'options ne sélectionne rien.
});

test.todo("terminal — sélection non entière", function testerTerminalSelectionNonEntiere() {
  // TODO : Tester une saisie décimale ou alphanumérique et préciser le rejet attendu plutôt qu'une sélection par préfixe numérique.
});

test.todo("terminal — confirmations avec casse variable", function testerTerminalConfirmationsAvecCasseVariable() {
  // TODO : Vérifier Oui, YES et espaces périphériques sans dépendre d'une entrée terminal réelle.
});

test.todo("terminal — confirmation négative inattendue", function testerTerminalConfirmationNegativeInattendue() {
  // TODO : Vérifier qu'une réponse autre que les formes positives documentées ne vaut pas approbation.
});

test.todo("terminal — fin de flux pendant confirmation", function testerTerminalFinDeFluxPendantConfirmation() {
  // TODO : Fermer l'entrée pendant confirm et vérifier une annulation sans approbation implicite.
});

test.todo("terminal — libération répétée du terminal", function testerTerminalLiberationRepeteeDuTerminal() {
  // TODO : Vérifier qu'une fermeture répétée libère proprement les listeners sans exception.
});

test.todo("terminal — largeur de terminal absente", function testerTerminalLargeurDeTerminalAbsente() {
  // TODO : Vérifier la largeur de repli lorsque le flux ne fournit pas columns.
});

test.todo("terminal — détection ANSI sur stderr", function testerTerminalDetectionANSISurStderr() {
  // TODO : Utiliser des flux stdout et stderr aux capacités différentes et vérifier la sélection du flux pour le streaming.
});

test.todo("terminal — erreur écriture terminal", function testerTerminalErreurEcritureTerminal() {
  // TODO : Simuler une erreur du flux et vérifier qu'elle reste visible au niveau appelant sans boucle de réessai.
});
