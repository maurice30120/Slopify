import test from 'node:test';

test.todo("codexModelsCacheCompat — commande Codex directe", function testerCodexModelsCacheCompatCommandeCodexDirecte() {
  // TODO : Vérifier la reconnaissance de codex sans dépendre d'une installation locale.
});

test.todo("codexModelsCacheCompat — adaptateur Codex versionné", function testerCodexModelsCacheCompatAdaptateurCodexVersionne() {
  // TODO : Vérifier les arguments @zed-industries/codex-acp avec et sans suffixe de version.
});

test.todo("codexModelsCacheCompat — commande au nom ressemblant", function testerCodexModelsCacheCompatCommandeAuNomRessemblant() {
  // TODO : Vérifier qu'un argument contenant seulement un sous-texte similaire n'est pas reconnu.
});

test.todo("codexModelsCacheCompat — cache absent", function testerCodexModelsCacheCompatCacheAbsent() {
  // TODO : Simuler un cache inexistant et vérifier l'absence d'écriture et d'erreur.
});

test.todo("codexModelsCacheCompat — cache JSON invalide", function testerCodexModelsCacheCompatCacheJSONInvalide() {
  // TODO : Simuler un JSON invalide et vérifier le journal d'erreur sans réécriture du fichier.
});

test.todo("codexModelsCacheCompat — niveaux de raisonnement non compatibles", function testerCodexModelsCacheCompatNiveauxDeRaisonnementNonCompatibles() {
  // TODO : Vérifier que les niveaux effort non reconnus sont retirés et que les niveaux historiques sont conservés.
});

test.todo("codexModelsCacheCompat — niveau par défaut max ou ultra", function testerCodexModelsCacheCompatNiveauParDefautMaxOuUltra() {
  // TODO : Vérifier le remplacement par xhigh sans modifier les autres propriétés du modèle.
});

test.todo("codexModelsCacheCompat — champ de résumé absent ou explicite", function testerCodexModelsCacheCompatChampDeResumeAbsentOuExplicite() {
  // TODO : Vérifier l'ajout de false seulement lorsque supports_reasoning_summaries est absent.
});

test.todo("codexModelsCacheCompat — cache déjà normalisé", function testerCodexModelsCacheCompatCacheDejaNormalise() {
  // TODO : Vérifier qu'aucune écriture n'a lieu pour un cache déjà compatible.
});

test.todo("codexModelsCacheCompat — normalisation répétée", function testerCodexModelsCacheCompatNormalisationRepetee() {
  // TODO : Simuler deux appels et vérifier que le second n'apporte aucune nouvelle modification ; isoler homedir et fs.
});
