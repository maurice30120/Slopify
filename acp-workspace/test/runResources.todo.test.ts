import test from 'node:test';

test.todo("runResources — version de snapshot non reconnue", function testerRunResourcesVersionDeSnapshotNonReconnue() {
  // TODO : Vérifier le rejet d'une version inconnue avant toute connexion ACP.
});

test.todo("runResources — programme figé manquant", function testerRunResourcesProgrammeFigeManquant() {
  // TODO : Retirer le programme du snapshot simulé et vérifier que la Reprise est refusée.
});

test.todo("runResources — ressource modifiée à taille constante", function testerRunResourcesRessourceModifieeATailleConstante() {
  // TODO : Changer le contenu d'un fichier sans changer sa taille et vérifier la détection par empreinte.
});

test.todo("runResources — dépendance transitive de skill", function testerRunResourcesDependanceTransitiveDeSkill() {
  // TODO : Vérifier la copie et la résolution de toutes les dépendances transitives d'une skill explicite.
});

test.todo("runResources — dépendance répétée ou cyclique", function testerRunResourcesDependanceRepeteeOuCyclique() {
  // TODO : Vérifier qu'une dépendance visitée plusieurs fois ne provoque ni copie répétée ni récursion infinie.
});

test.todo("runResources — collision des origines de skills", function testerRunResourcesCollisionDesOriginesDeSkills() {
  // TODO : Vérifier qu'un nom simple reste local au projet et que slopify: sélectionne la skill embarquée même en présence d'un homonyme.
});

test.todo("runResources — skill absente du manifeste distribué", function testerRunResourcesSkillAbsenteDuManifesteDistribue() {
  // TODO : Vérifier le refus d'une skill slopify non déclarée dans le manifeste.
});

test.todo("runResources — prérequis vide ou répertoire", function testerRunResourcesPrerequisVideOuRepertoire() {
  // TODO : Vérifier qu'un prérequis pointant vers un fichier blanc ou un dossier bloque le lancement.
});

test.todo("runResources — chemin de ressource hors racine", function testerRunResourcesCheminDeRessourceHorsRacine() {
  // TODO : Tester un chemin contenant une traversée de parent et vérifier le rejet avant copie.
});

test.todo("runResources — ressources binaires et exécutables", function testerRunResourcesRessourcesBinairesEtExecutables() {
  // TODO : Vérifier la conservation du contenu binaire et des permissions nécessaires des scripts lors du gel.
});

test.todo("runResources — réutilisation du même run", function testerRunResourcesReutilisationDuMemeRun() {
  // TODO : Préparer deux fois le même identifiant de run et vérifier la réutilisation de la copie figée initiale.
});
