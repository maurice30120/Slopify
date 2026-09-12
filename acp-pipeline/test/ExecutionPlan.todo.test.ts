import test from 'node:test';

test.todo("ExecutionPlan — révision invalide", function testerExecutionPlanRevisionInvalide() {
  // TODO : Vérifier séparément le rejet de zéro, des nombres négatifs, fractionnaires et non finis comme révision.
});

test.todo("ExecutionPlan — copie profonde des tickets", function testerExecutionPlanCopieProfondeDesTickets() {
  // TODO : Modifier scope, needs et validation du Ticket Graph après compilation ; vérifier que le plan reste inchangé.
});

test.todo("ExecutionPlan — gel des structures imbriquées", function testerExecutionPlanGelDesStructuresImbriquees() {
  // TODO : Vérifier le gel du plan, de ses nœuds, des tickets et des dépendances de la revue finale.
});

test.todo("ExecutionPlan — graphe en diamant", function testerExecutionPlanGrapheEnDiamant() {
  // TODO : Compiler A vers B et C puis D ; vérifier les dépendances préservées et D comme unique terminal.
});

test.todo("ExecutionPlan — graphe avec branches déconnectées", function testerExecutionPlanGrapheAvecBranchesDeconnectees() {
  // TODO : Vérifier que la revue finale attend tous les terminaux de plusieurs composantes indépendantes.
});

test.todo("ExecutionPlan — identifiant réservé final-review", function testerExecutionPlanIdentifiantReserveFinalReview() {
  // TODO : Tester un ticket nommé final-review et définir le diagnostic évitant la collision avec le nœud synthétique.
});

test.todo("ExecutionPlan — dépendances désynchronisées du ticket", function testerExecutionPlanDependancesDesynchroniseesDuTicket() {
  // TODO : Modifier node.needs sans modifier ticket.needs dans un snapshot et vérifier le rejet de la divergence.
});

test.todo("ExecutionPlan — terminaux falsifiés", function testerExecutionPlanTerminauxFalsifies() {
  // TODO : Vérifier le rejet d'un snapshot dont terminalNodeIds omet une feuille ou ajoute un nœud non terminal.
});

test.todo("ExecutionPlan — expansion pending incohérente", function testerExecutionPlanExpansionPendingIncoherente() {
  // TODO : Tester pending avec expandedNodeIds non vide et vérifier le diagnostic du snapshot.
});

test.todo("ExecutionPlan — expansion avec identifiants répétés", function testerExecutionPlanExpansionAvecIdentifiantsRepetes() {
  // TODO : Vérifier qu'une expansion contenant un doublon ne constitue pas la preuve d'une expansion complète.
});

test.todo("ExecutionPlan — horodatage d'expansion invalide", function testerExecutionPlanHorodatageDExpansionInvalide() {
  // TODO : Vérifier le rejet d'un expandedAt absent, vide ou impossible à interpréter.
});
