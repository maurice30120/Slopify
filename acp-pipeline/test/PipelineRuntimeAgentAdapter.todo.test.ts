import test from 'node:test';

test.todo("PipelineRuntimeAgentAdapter — envoi sur session fermée", function testerPipelineRuntimeAgentAdapterEnvoiSurSessionFermee() {
  // TODO : Fermer la session puis envoyer un tour et vérifier agent_session_closed sans appel au runner.
});

test.todo("PipelineRuntimeAgentAdapter — agent manquant", function testerPipelineRuntimeAgentAdapterAgentManquant() {
  // TODO : Vérifier missing_agent avant toute exécution du runner.
});

test.todo("PipelineRuntimeAgentAdapter — sortie manquante", function testerPipelineRuntimeAgentAdapterSortieManquante() {
  // TODO : Vérifier missing_output avant toute exécution du runner.
});

test.todo("PipelineRuntimeAgentAdapter — signal déjà annulé", function testerPipelineRuntimeAgentAdapterSignalDejaAnnule() {
  // TODO : Créer une session avec un signal annulé et vérifier sa transmission au runner.
});

test.todo("PipelineRuntimeAgentAdapter — erreur non Error du runner", function testerPipelineRuntimeAgentAdapterErreurNonErrorDuRunner() {
  // TODO : Faire rejeter le runner avec une chaîne ou un objet et vérifier la conversion en diagnostic agent_failed.
});

test.todo("PipelineRuntimeAgentAdapter — divergence de reprise préservée", function testerPipelineRuntimeAgentAdapterDivergenceDeReprisePreservee() {
  // TODO : Vérifier qu'une PipelineSandboxResumeDivergenceError est propagée sans être aplatie en agent_failed.
});

test.todo("PipelineRuntimeAgentAdapter — finalisation facultative", function testerPipelineRuntimeAgentAdapterFinalisationFacultative() {
  // TODO : Vérifier le résultat en absence de hook puis la transmission exacte des arguments lorsque le hook existe.
});

test.todo("PipelineRuntimeAgentAdapter — fermeture garantie après execute", function testerPipelineRuntimeAgentAdapterFermetureGarantieApresExecute() {
  // TODO : Simuler une erreur d'envoi et vérifier que execute ferme tout de même la session.
});
