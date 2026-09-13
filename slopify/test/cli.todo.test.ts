import test from 'node:test';

test.todo("cli — aide sans backend", function testerCliAideSansBackend() {
  // TODO : Vérifier que main affiche l'aide et renvoie 0 sans construire de backend.
});

test.todo("cli — liste avec code de succès", function testerCliListeAvecCodeDeSucces() {
  // TODO : Simuler un catalogue vide puis non vide et vérifier le code 0 et le format demandé.
});

test.todo("cli — run terminé avec code zéro", function testerCliRunTermineAvecCodeZero() {
  // TODO : Simuler un run completed et vérifier le code de sortie 0.
});

test.todo("cli — run non terminé avec code deux", function testerCliRunNonTermineAvecCodeDeux() {
  // TODO : Simuler séparément failed, rejected et cancelled puis vérifier le code de sortie 2.
});

test.todo("cli — erreur d'arguments avec code un", function testerCliErreurDArgumentsAvecCodeUn() {
  // TODO : Fournir une option invalide et vérifier le code 1 avec diagnostic sur stderr.
});

test.todo("cli — erreur inattendue du backend", function testerCliErreurInattendueDuBackend() {
  // TODO : Simuler une exception de construction ou d'exécution et vérifier le diagnostic et le code 1.
});

test.todo("cli — transmission de keepSandboxes", function testerCliTransmissionDeKeepSandboxes() {
  // TODO : Vérifier que la factory reçoit le bon booléen pour list, run et resume.
});

test.todo("cli — nettoyage sur chaque sortie", function testerCliNettoyageSurChaqueSortie() {
  // TODO : Simuler succès, aide et erreur puis vérifier la fermeture du terminal et du host créé.
});

test.todo("cli — import sans lancement automatique", function testerCliImportSansLancementAutomatique() {
  // TODO : Importer le module avec un point d'entrée différent et vérifier qu'aucun main n'est exécuté.
});
