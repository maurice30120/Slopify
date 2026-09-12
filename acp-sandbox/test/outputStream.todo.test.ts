import test from 'node:test';

test.todo("outputStream — objet JSON réparti sur plusieurs chunks", function testerOutputStreamObjetJSONRepartiSurPlusieursChunks() {
  // TODO : Découper une ligne JSON à chaque frontière possible et vérifier une émission seulement après sa fin.
});

test.todo("outputStream — plusieurs lignes par chunk", function testerOutputStreamPlusieursLignesParChunk() {
  // TODO : Vérifier que plusieurs événements complets dans un chunk sont émis dans leur ordre.
});

test.todo("outputStream — dernière ligne sans saut de ligne", function testerOutputStreamDerniereLigneSansSautDeLigne() {
  // TODO : Vérifier que flush émet la dernière ligne et vide le tampon.
});

test.todo("outputStream — flush répété", function testerOutputStreamFlushRepete() {
  // TODO : Appeler flush deux fois et vérifier qu'aucun événement n'est dupliqué.
});

test.todo("outputStream — lignes vides et CRLF", function testerOutputStreamLignesVidesEtCRLF() {
  // TODO : Vérifier l'ignorance des lignes blanches et la lecture correcte des événements terminés par CRLF.
});

test.todo("outputStream — texte brut non JSON", function testerOutputStreamTexteBrutNonJSON() {
  // TODO : Vérifier le repli en agent_message_chunk avec le saut de ligne attendu.
});

test.todo("outputStream — valeurs JSON primitives", function testerOutputStreamValeursJSONPrimitives() {
  // TODO : Vérifier que null, nombres, booléens et chaînes JSON n'émettent aucun message d'agent.
});

test.todo("outputStream — événements outils masqués", function testerOutputStreamEvenementsOutilsMasques() {
  // TODO : Vérifier que les payloads d'appels outils de chaque fournisseur ne sont pas exposés comme messages.
});

test.todo("outputStream — messages Vibe non assistant", function testerOutputStreamMessagesVibeNonAssistant() {
  // TODO : Vérifier que les messages user et tool de Vibe sont ignorés.
});

test.todo("outputStream — blocs Vibe mélangés", function testerOutputStreamBlocsVibeMelanges() {
  // TODO : Combiner blocs texte, images, null et blocs mal formés puis vérifier la concaténation des seuls textes valides.
});

test.todo("outputStream — texte absent ou vide", function testerOutputStreamTexteAbsentOuVide() {
  // TODO : Vérifier qu'un événement reconnu avec un texte absent, non textuel ou vide n'émet rien.
});

test.todo("outputStream — flux indépendants par agent", function testerOutputStreamFluxIndependantsParAgent() {
  // TODO : Entrelacer les appels sur deux instances et vérifier que leurs tampons restent séparés.
});
