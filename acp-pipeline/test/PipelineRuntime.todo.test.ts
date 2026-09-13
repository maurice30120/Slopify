import test from 'node:test';

test.todo("PipelineRuntime — modèles avec valeurs primitives", function testerPipelineRuntimeModelesAvecValeursPrimitives() {
  // TODO : Vérifier le rendu de zéro, false et chaînes vides par renderRuntimeTemplate sans les perdre.
});

test.todo("PipelineRuntime — modèle avec variable inconnue", function testerPipelineRuntimeModeleAvecVariableInconnue() {
  // TODO : Vérifier le comportement documenté d'une variable absente sans altérer les autres substitutions.
});

test.todo("PipelineRuntime — inspect sans fuite de mutations", function testerPipelineRuntimeInspectSansFuiteDeMutations() {
  // TODO : Modifier un snapshot retourné par inspect et vérifier que le runtime conserve son état interne.
});

test.todo("PipelineRuntime — reprise avec identifiant de pause périmé", function testerPipelineRuntimeRepriseAvecIdentifiantDePausePerime() {
  // TODO : Vérifier qu'une ancienne décision ne peut pas approuver la pause courante après une nouvelle pause.
});

test.todo("PipelineRuntime — nouvelle tentative avec nœud inconnu", function testerPipelineRuntimeNouvelleTentativeAvecNUdInconnu() {
  // TODO : Vérifier que retryNode refuse un identifiant absent sans relancer un autre agent.
});

test.todo("PipelineRuntime — artefact de sortie au nom incorrect", function testerPipelineRuntimeArtefactDeSortieAuNomIncorrect() {
  // TODO : Faire retourner un autre nom d'artefact et vérifier le diagnostic avant l'exécution des descendants.
});

test.todo("PipelineRuntime — artefact de sortie au format incorrect", function testerPipelineRuntimeArtefactDeSortieAuFormatIncorrect() {
  // TODO : Faire retourner un format différent du contrat et vérifier que le nœud ne se termine pas avec succès.
});

test.todo("PipelineRuntime — échec du store avant lancement", function testerPipelineRuntimeEchecDuStoreAvantLancement() {
  // TODO : Simuler une erreur de create et vérifier qu'aucune session d'agent ne démarre.
});

test.todo("PipelineRuntime — annulation pendant le backoff", function testerPipelineRuntimeAnnulationPendantLeBackoff() {
  // TODO : Utiliser une horloge simulée pour vérifier qu'une annulation pendant l'attente empêche toute nouvelle tentative.
});

test.todo("PipelineRuntime — frontier sans barrière de niveau globale", function testerPipelineRuntimeFrontierSansBarriereDeNiveauGlobale() {
  // TODO : Terminer une branche courte pendant qu'une autre racine reste active et vérifier que son descendant démarre immédiatement.
});

test.todo("PipelineRuntime — durée calculée avec une horloge injectée", function testerPipelineRuntimeDureeCalculeeAvecUneHorlogeInjectee() {
  // TODO : Vérifier durationMs sur succès et échec en contrôlant now, sans utiliser l'horloge réelle.
});

test.todo("PipelineRuntime — résumé de checkpoint indisponible", function testerPipelineRuntimeResumeDeCheckpointIndisponible() {
  // TODO : Vérifier que filesChanged est omis lorsque le checkpoint n'est pas encore disponible.
});
