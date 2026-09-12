import test from 'node:test';

test.todo("markdownBlockStream — CRLF réparti entre chunks", function testerMarkdownBlockStreamCRLFRepartiEntreChunks() {
  // TODO : Découper le retour chariot et le saut de ligne en deux appels et vérifier un rendu sans duplication.
});

test.todo("markdownBlockStream — délimiteurs de code découpés", function testerMarkdownBlockStreamDelimiteursDeCodeDecoupes() {
  // TODO : Répartir les trois accents graves sur plusieurs chunks et vérifier la stabilité du bloc rendu.
});

test.todo("markdownBlockStream — listes imbriquées incomplètes", function testerMarkdownBlockStreamListesImbriqueesIncompletes() {
  // TODO : Vérifier qu'une liste et ses sous-listes ne sont émises qu'une fois stabilisées ou vidées.
});

test.todo("markdownBlockStream — citation prolongée par plusieurs chunks", function testerMarkdownBlockStreamCitationProlongeeParPlusieursChunks() {
  // TODO : Vérifier qu'un bloc de citation conserve sa structure jusqu'au bloc suivant.
});

test.todo("markdownBlockStream — caractères Unicode coupés", function testerMarkdownBlockStreamCaracteresUnicodeCoupes() {
  // TODO : Découper une chaîne entre les unités UTF-16 d'un caractère et vérifier sa restitution sans corruption.
});

test.todo("markdownBlockStream — neutralisation des contrôles terminal", function testerMarkdownBlockStreamNeutralisationDesControlesTerminal() {
  // TODO : Fournir ESC, BEL et séquences de curseur dans le texte et vérifier qu'ils ne sont pas exécutables dans le rendu.
});

test.todo("markdownBlockStream — reprise après reset", function testerMarkdownBlockStreamRepriseApresReset() {
  // TODO : Appeler push, reset puis push avec un nouveau document et vérifier qu'aucun ancien contenu ne réapparaît.
});

test.todo("markdownBlockStream — vidage d'un bloc déjà stabilisé", function testerMarkdownBlockStreamVidageDUnBlocDejaStabilise() {
  // TODO : Vérifier que flush n'émet pas une seconde fois le dernier bloc déjà rendu.
});
