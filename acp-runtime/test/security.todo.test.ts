import test from 'node:test';

test.todo("security — préfixe de répertoire trompeur", function testerSecurityPrefixeDeRepertoireTrompeur() {
  // TODO : Tester un chemin voisin partageant le préfixe du workspace et vérifier son rejet.
});

test.todo("security — écriture sous ancêtre symbolique extérieur", function testerSecurityEcritureSousAncetreSymboliqueExterieur() {
  // TODO : Tester une cible inexistante sous un lien vers l'extérieur et vérifier le rejet avant écriture.
});

test.todo("security — lien symbolique intérieur valide", function testerSecurityLienSymboliqueInterieurValide() {
  // TODO : Vérifier qu'un lien restant dans le workspace est résolu vers son chemin réel.
});

test.todo("security — workspace lui-même symbolique", function testerSecurityWorkspaceLuiMemeSymbolique() {
  // TODO : Vérifier que la racine réelle du workspace est utilisée pour le contrôle des descendants.
});

test.todo("security — variables autorisées intactes", function testerSecurityVariablesAutoriseesIntactes() {
  // TODO : Vérifier que filterEnv conserve noms, casse et valeurs des variables non interdites.
});

test.todo("security — toute la liste des variables interdites", function testerSecurityTouteLaListeDesVariablesInterdites() {
  // TODO : Vérifier chaque variable interdite, dans plusieurs casses, et l'absence de mutation de l'entrée.
});

test.todo("security — fichier en lecture inexistante", function testerSecurityFichierEnLectureInexistante() {
  // TODO : Vérifier que readTextFile propage l'erreur du fichier absent.
});

test.todo("security — lecture avec limite seule", function testerSecurityLectureAvecLimiteSeule() {
  // TODO : Vérifier la lecture à partir de la première ligne quand limit est fourni sans line.
});

test.todo("security — lecture après fin de fichier", function testerSecurityLectureApresFinDeFichier() {
  // TODO : Vérifier le résultat d'une tranche démarrant après la dernière ligne.
});

test.todo("security — écriture via lien vers ressources figées", function testerSecurityEcritureViaLienVersRessourcesFigees() {
  // TODO : Vérifier qu'un chemin indirect vers une ressource en lecture seule est également refusé.
});
