import test from 'node:test';

test.todo("operationGuards — valeurs par défaut des délais", function testerOperationGuardsValeursParDefautDesDelais() {
  // TODO : Vérifier que resolveTimeouts retourne une copie des valeurs par défaut sans les modifier.
});

test.todo("operationGuards — surcharge partielle des délais", function testerOperationGuardsSurchargePartielleDesDelais() {
  // TODO : Remplacer une seule limite et vérifier que toutes les autres restent inchangées.
});

test.todo("operationGuards — résolution avant expiration", function testerOperationGuardsResolutionAvantExpiration() {
  // TODO : Vérifier que withTimeout retourne la valeur et retire le temporisateur lorsque la promesse gagne.
});

test.todo("operationGuards — rejet avant expiration", function testerOperationGuardsRejetAvantExpiration() {
  // TODO : Vérifier que l'erreur initiale est conservée et que onTimeout n'est pas appelé.
});

test.todo("operationGuards — expiration avec métadonnées", function testerOperationGuardsExpirationAvecMetadonnees() {
  // TODO : Utiliser des timers simulés et vérifier phase, timeoutMs et type de PipelineTimeoutError.
});

test.todo("operationGuards — désactivation du délai", function testerOperationGuardsDesactivationDuDelai() {
  // TODO : Tester zéro, valeur négative et valeurs non finies ; vérifier qu'aucun timer n'est installé.
});

test.todo("operationGuards — échec asynchrone du callback de délai", function testerOperationGuardsEchecAsynchroneDuCallbackDeDelai() {
  // TODO : Faire rejeter onTimeout et vérifier que l'erreur finale reste PipelineTimeoutError sans rejet non géré.
});

test.todo("operationGuards — callback de délai appelé une seule fois", function testerOperationGuardsCallbackDeDelaiAppeleUneSeuleFois() {
  // TODO : Résoudre tardivement la promesse initiale après expiration et vérifier l'unicité de onTimeout.
});

test.todo("operationGuards — garde sans processus observable", function testerOperationGuardsGardeSansProcessusObservable() {
  // TODO : Vérifier que withProcessGuard restitue directement valeur ou erreur quand processExit est absent.
});

test.todo("operationGuards — arrêt de processus avant résultat", function testerOperationGuardsArretDeProcessusAvantResultat() {
  // TODO : Simuler une sortie et vérifier AgentProcessDiedError avec la phase, le code et le signal.
});

test.todo("operationGuards — erreur de lancement dans le garde", function testerOperationGuardsErreurDeLancementDansLeGarde() {
  // TODO : Simuler exit.error et vérifier que son message apparaît dans le diagnostic.
});

test.todo("operationGuards — résultat avant arrêt du processus", function testerOperationGuardsResultatAvantArretDuProcessus() {
  // TODO : Résoudre l'opération puis le processus et vérifier qu'aucun échec tardif ne remplace le résultat.
});
