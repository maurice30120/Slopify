import test from 'node:test';

test.todo("hostAndRun — artefact final absent", function testerHostAndRunArtefactFinalAbsent() {
  // TODO : Vérifier qu'un run terminé sans artefact ne produit pas de texte undefined ou null.
});

test.todo("hostAndRun — artefact final primitif", function testerHostAndRunArtefactFinalPrimitif() {
  // TODO : Vérifier le rendu de false et zéro sans les confondre avec une absence de résultat.
});

test.todo("hostAndRun — JSON sur erreur", function testerHostAndRunJSONSurErreur() {
  // TODO : Vérifier une sortie finale JSON parseable même lorsque le run échoue.
});

test.todo("hostAndRun — réponse vide en entretien", function testerHostAndRunReponseVideEnEntretien() {
  // TODO : Vérifier le renouvellement de la question sans envoyer de réponse vide au backend.
});

test.todo("hostAndRun — erreur du backend pendant reprise", function testerHostAndRunErreurDuBackendPendantReprise() {
  // TODO : Vérifier la remontée du diagnostic sans démarrage implicite d'un nouveau run.
});

test.todo("hostAndRun — isolation des flux de deux nœuds", function testerHostAndRunIsolationDesFluxDeDeuxNUds() {
  // TODO : Entrelacer les messages de deux agents et vérifier des tampons et préfixes distincts.
});

test.todo("hostAndRun — transition pensée vers réponse", function testerHostAndRunTransitionPenseeVersReponse() {
  // TODO : Vérifier que le tampon de pensée est vidé une seule fois avant le premier bloc de réponse.
});

test.todo("hostAndRun — vidage du streaming sur échec", function testerHostAndRunVidageDuStreamingSurEchec() {
  // TODO : Faire échouer le nœud avec un bloc partiel en attente et vérifier sa restitution avant le diagnostic.
});

test.todo("hostAndRun — snapshot cumulatif identique", function testerHostAndRunSnapshotCumulatifIdentique() {
  // TODO : Envoyer deux notifications cumulatives identiques et vérifier qu'aucun texte n'est dupliqué.
});

test.todo("hostAndRun — streaming désactivé par environnement", function testerHostAndRunStreamingDesactiveParEnvironnement() {
  // TODO : Vérifier que SLOPIFY_ANSI_STREAM=0 conserve le texte brut même sur un terminal compatible ANSI.
});

test.todo("hostAndRun — priorité du pipeline projet", function testerHostAndRunPrioriteDuPipelineProjet() {
  // TODO : Déclarer un pipeline local homonyme du pipeline fourni et vérifier sa sélection sans modifier les autres pipelines embarqués.
});

test.todo("hostAndRun — garde du workspace avant écriture", function testerHostAndRunGardeDuWorkspaceAvantEcriture() {
  // TODO : Simuler l'échec du préflight et vérifier qu'aucun journal ni ressource de run n'est créé.
});
