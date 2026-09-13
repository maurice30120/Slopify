import test from 'node:test';

test.todo("PipelineSkillsAndInterview — échappement des métadonnées de skills", function testerPipelineSkillsAndInterviewEchappementDesMetadonneesDeSkills() {
  // TODO : Vérifier le rendu des caractères XML spéciaux dans noms, descriptions et chemins.
});

test.todo("PipelineSkillsAndInterview — rendu d'un catalogue vide", function testerPipelineSkillsAndInterviewRenduDUnCatalogueVide() {
  // TODO : Vérifier que les renderers de skills n'émettent pas de bloc artificiel en absence de skills.
});

test.todo("PipelineSkillsAndInterview — références de skills répétées", function testerPipelineSkillsAndInterviewReferencesDeSkillsRepetees() {
  // TODO : Vérifier qu'une même skill demandée via son nom et son alias n'est injectée qu'une fois.
});

test.todo("PipelineSkillsAndInterview — catalogue stable malgré l'ordre source", function testerPipelineSkillsAndInterviewCatalogueStableMalgreLOrdreSource() {
  // TODO : Permuter l'ordre des skills et vérifier un rendu déterministe du catalogue découvrable.
});

test.todo("PipelineSkillsAndInterview — protocole d'entretien inconnu", function testerPipelineSkillsAndInterviewProtocoleDEntretienInconnu() {
  // TODO : Vérifier que getPipelineInterviewProtocol ne résout pas un identifiant inconnu.
});

test.todo("PipelineSkillsAndInterview — replay d'entretien avec plusieurs tours", function testerPipelineSkillsAndInterviewReplayDEntretienAvecPlusieursTours() {
  // TODO : Vérifier que questions, réponses et demande de fin sont restituées dans leur ordre sans perdre le prompt initial.
});

test.todo("PipelineSkillsAndInterview — instruction de réparation contextualisée", function testerPipelineSkillsAndInterviewInstructionDeReparationContextualisee() {
  // TODO : Vérifier que renderRepair conserve le diagnostic et les consignes du protocole.
});

test.todo("PipelineSkillsAndInterview — demande de sortie finale contextualisée", function testerPipelineSkillsAndInterviewDemandeDeSortieFinaleContextualisee() {
  // TODO : Vérifier que renderFinalOutputRequest contient le diagnostic et n'introduit pas de nouvelle question.
});
