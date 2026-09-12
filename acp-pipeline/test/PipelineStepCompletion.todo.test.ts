import test from 'node:test';

test.todo("PipelineStepCompletion — résultat texte direct", function testerPipelineStepCompletionResultatTexteDirect() {
  // TODO : Vérifier que resolvePipelineStepText conserve exactement une chaîne, y compris une chaîne vide.
});

test.todo("PipelineStepCompletion — résultat structuré sans décision", function testerPipelineStepCompletionResultatStructureSansDecision() {
  // TODO : Vérifier que le texte est conservé lorsque promotion est absent.
});

test.todo("PipelineStepCompletion — Promotion appliquée ou sans changements", function testerPipelineStepCompletionPromotionAppliqueeOuSansChangements() {
  // TODO : Vérifier que applied et no_changes renvoient le texte sans lever d'erreur.
});

test.todo("PipelineStepCompletion — Rejection typée", function testerPipelineStepCompletionRejectionTypee() {
  // TODO : Vérifier que rejected lève PipelineStepRejectedError et est reconnu par isPipelineStepRejected uniquement.
});

test.todo("PipelineStepCompletion — Cancellation typée", function testerPipelineStepCompletionCancellationTypee() {
  // TODO : Vérifier que cancelled lève PipelineStepCancelledError et est reconnu par isPipelineStepCancelled uniquement.
});

test.todo("PipelineStepCompletion — gardes face aux valeurs étrangères", function testerPipelineStepCompletionGardesFaceAuxValeursEtrangeres() {
  // TODO : Vérifier que null, objets ordinaires et erreurs portant seulement un message similaire ne passent pas les gardes.
});
