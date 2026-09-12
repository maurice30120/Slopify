import test from 'node:test';

test.todo("PipelineV3Compiler — racine YAML non objet", function testerPipelineV3CompilerRacineYAMLNonObjet() {
  // TODO : Tester null, scalaire et tableau en entrée et vérifier les diagnostics sans exception non maîtrisée.
});

test.todo("PipelineV3Compiler — identifiants hors grammaire", function testerPipelineV3CompilerIdentifiantsHorsGrammaire() {
  // TODO : Tester les identifiants commençant par un chiffre ou contenant un point et vérifier leur rejet.
});

test.todo("PipelineV3Compiler — agent absent du catalogue", function testerPipelineV3CompilerAgentAbsentDuCatalogue() {
  // TODO : Vérifier qu'un nœud référençant un agent inconnu empêche la compilation.
});

test.todo("PipelineV3Compiler — bornes du nombre de tentatives", function testerPipelineV3CompilerBornesDuNombreDeTentatives() {
  // TODO : Vérifier les bornes 1 et 10 ainsi que le rejet de 0, 11 et des valeurs fractionnaires.
});

test.todo("PipelineV3Compiler — bornes du délai de nouvelle tentative", function testerPipelineV3CompilerBornesDuDelaiDeNouvelleTentative() {
  // TODO : Vérifier les bornes 0 et 60000 et le rejet des valeurs négatives, fractionnaires ou supérieures.
});

test.todo("PipelineV3Compiler — politique nommée inconnue", function testerPipelineV3CompilerPolitiqueNommeeInconnue() {
  // TODO : Vérifier qu'une référence de politique absente produit un diagnostic localisé au nœud.
});

test.todo("PipelineV3Compiler — entrées de même nom", function testerPipelineV3CompilerEntreesDeMemeNom() {
  // TODO : Vérifier que deux inputs homonymes sur un nœud sont rejetés.
});

test.todo("PipelineV3Compiler — artefact issu d'une branche non ancêtre", function testerPipelineV3CompilerArtefactIssuDUneBrancheNonAncetre() {
  // TODO : Vérifier qu'une entrée référençant une sortie existante mais non dépendante ne peut pas être compilée.
});

test.todo("PipelineV3Compiler — interaction interdite sur une pause", function testerPipelineV3CompilerInteractionInterditeSurUnePause() {
  // TODO : Vérifier qu'une pause ne peut pas déclarer un protocole d'entretien réservé aux agents.
});

test.todo("PipelineV3Compiler — lecture des index immuables", function testerPipelineV3CompilerLectureDesIndexImmuables() {
  // TODO : Vérifier get, has, size, itérateurs et forEach des index publics, sans exposer de mutation.
});
