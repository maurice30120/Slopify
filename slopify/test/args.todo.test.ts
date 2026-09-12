import test from 'node:test';

test.todo("args — reprise sans identifiant", function testerArgsRepriseSansIdentifiant() {
  // TODO : Vérifier le message d'usage de resume lorsque l'identifiant est absent ou blanc.
});

test.todo("args — reprise avec plusieurs identifiants", function testerArgsRepriseAvecPlusieursIdentifiants() {
  // TODO : Vérifier que resume rejette les arguments positionnels surnuméraires.
});

test.todo("args — liste avec argument positionnel", function testerArgsListeAvecArgumentPositionnel() {
  // TODO : Vérifier que list refuse un prompt ou un identifiant inattendu.
});

test.todo("args — prompt Unicode multiligne", function testerArgsPromptUnicodeMultiligne() {
  // TODO : Vérifier la conservation des accents, caractères non latins et sauts de ligne du prompt.
});

test.todo("args — options après le séparateur", function testerArgsOptionsApresLeSeparateur() {
  // TODO : Vérifier que les options ressemblant à --help ou --pipeline après -- restent du texte du prompt.
});

test.todo("args — valeur pipeline composée d'espaces", function testerArgsValeurPipelineComposeeDEspaces() {
  // TODO : Tester un nom de pipeline blanc et préciser le rejet attendu au lieu d'une sélection vide.
});

test.todo("args — chemin workspace avec espaces", function testerArgsCheminWorkspaceAvecEspaces() {
  // TODO : Vérifier que -c préserve les espaces et résout le chemin relativement à baseCwd.
});

test.todo("args — options répétées", function testerArgsOptionsRepetees() {
  // TODO : Vérifier la règle de priorité de la dernière occurrence pour cwd, pipeline et verbosité.
});

test.todo("args — options sans mutation des arguments", function testerArgsOptionsSansMutationDesArguments() {
  // TODO : Vérifier que parseCliArgs laisse le tableau argv initial inchangé.
});
