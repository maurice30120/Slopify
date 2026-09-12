import test from 'node:test';

test.todo("runtime — version sbx non interprétable", function testerRuntimeVersionSbxNonInterpretable() {
  // TODO : Simuler une sortie de version mal formée et vérifier un diagnostic avant toute création.
});

test.todo("runtime — échec de clonage", function testerRuntimeEchecDeClonage() {
  // TODO : Simuler sbx clone en échec et vérifier l'absence d'exécution d'agent et la remontée du diagnostic.
});

test.todo("runtime — échec installation des ressources", function testerRuntimeEchecInstallationDesRessources() {
  // TODO : Faire échouer l'installation des ressources figées et vérifier que l'agent ne démarre pas.
});

test.todo("runtime — échec du callback de persistance", function testerRuntimeEchecDuCallbackDePersistance() {
  // TODO : Simuler un rejet de onSandboxRunState et vérifier que le run n'annonce pas un checkpoint durable inexistant.
});

test.todo("runtime — erreur de nettoyage après erreur agent", function testerRuntimeErreurDeNettoyageApresErreurAgent() {
  // TODO : Vérifier que le diagnostic initial reste identifiable si le nettoyage échoue lui aussi.
});

test.todo("runtime — modèle et effort transmis littéralement", function testerRuntimeModeleEtEffortTransmisLitteralement() {
  // TODO : Inspecter les arguments du faux exécuteur pour un modèle contenant ponctuation ou espaces, sans interpolation shell.
});

test.todo("runtime — absence de modèle effectif", function testerRuntimeAbsenceDeModeleEffectif() {
  // TODO : Vérifier le diagnostic de configuration avant création lorsqu'un modèle requis est manquant.
});

test.todo("runtime — Réparation remplaçant le checkpoint courant", function testerRuntimeReparationRemplacantLeCheckpointCourant() {
  // TODO : Vérifier qu'un forceRerun retire l'ancien checkpoint du tour avant de publier celui de la Réparation.
});

test.todo("runtime — extensions sans Sandbox Run actif", function testerRuntimeExtensionsSansSandboxRunActif() {
  // TODO : Vérifier les diagnostics de status, preview, promote et reject lorsque la ressource nécessaire n'existe plus.
});
