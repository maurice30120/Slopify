import test from 'node:test';

test.todo("PipelineRunStore — copie indépendante à la création", function testerPipelineRunStoreCopieIndependanteALaCreation() {
  // TODO : Créer un snapshot imbriqué, modifier l'objet fourni puis vérifier que le snapshot mémorisé reste inchangé.
});

test.todo("PipelineRunStore — copie indépendante à la lecture", function testerPipelineRunStoreCopieIndependanteALaLecture() {
  // TODO : Modifier les nœuds et artefacts du résultat de load puis relire le run pour vérifier son isolation.
});

test.todo("PipelineRunStore — sauvegarde indépendante du snapshot source", function testerPipelineRunStoreSauvegardeIndependanteDuSnapshotSource() {
  // TODO : Sauvegarder un snapshot puis modifier sa source ; vérifier que save a conservé une copie indépendante.
});

test.todo("PipelineRunStore — lecture d'un run absent", function testerPipelineRunStoreLectureDUnRunAbsent() {
  // TODO : Vérifier que les deux implémentations du store renvoient null pour un identifiant absent.
});

test.todo("PipelineRunStore — filtrage des statuts reprenables", function testerPipelineRunStoreFiltrageDesStatutsReprenables() {
  // TODO : Enregistrer chacun des statuts puis vérifier que listResumable retient uniquement running, paused et failed.
});

test.todo("PipelineRunStore — isolation des résultats de listResumable", function testerPipelineRunStoreIsolationDesResultatsDeListResumable() {
  // TODO : Modifier un snapshot renvoyé par listResumable puis vérifier que les lectures suivantes ne changent pas.
});

test.todo("PipelineRunStore — ordre du journal en mémoire", function testerPipelineRunStoreOrdreDuJournalEnMemoire() {
  // TODO : Ajouter plusieurs événements à deux runs et vérifier l'ordre et la séparation de leurs journaux.
});

test.todo("PipelineRunStore — suppression répétée d'un run en mémoire", function testerPipelineRunStoreSuppressionRepeteeDUnRunEnMemoire() {
  // TODO : Supprimer deux fois un run puis vérifier que snapshot et événements sont absents sans exception.
});

test.todo("PipelineRunStore — persistance JSON invalide", function testerPipelineRunStorePersistanceJSONInvalide() {
  // TODO : Simuler un snapshot JSON tronqué et vérifier que load propage l'erreur au lieu de renvoyer null.
});

test.todo("PipelineRunStore — erreur de lecture distincte de ENOENT", function testerPipelineRunStoreErreurDeLectureDistincteDeENOENT() {
  // TODO : Simuler un refus de lecture et vérifier que le store ne le transforme pas en run absent.
});

test.todo("PipelineRunStore — échec du renommage atomique", function testerPipelineRunStoreEchecDuRenommageAtomique() {
  // TODO : Simuler un échec de rename après l'écriture temporaire et vérifier que l'ancien snapshot reste complet.
});

test.todo("PipelineRunStore — identifiants avec caractères réservés", function testerPipelineRunStoreIdentifiantsAvecCaracteresReserves() {
  // TODO : Enregistrer puis lister un run dont l'identifiant contient espaces, slash et pourcentage ; vérifier son aller-retour sans double encodage.
});

test.todo("PipelineRunStore — séparation des dépôts", function testerPipelineRunStoreSeparationDesDepots() {
  // TODO : Utiliser deux repositoryId sous la même racine et vérifier que leurs snapshots ne se mélangent pas.
});

test.todo("PipelineRunStore — création sans écrasement du journal fichier", function testerPipelineRunStoreCreationSansEcrasementDuJournalFichier() {
  // TODO : Appeler create sur un run possédant déjà des événements et vérifier que le journal fichier est conservé.
});

test.todo("PipelineRunStore — fabriques de stores", function testerPipelineRunStoreFabriquesDeStores() {
  // TODO : Vérifier les racines produites par workspacePipelineRunStore et userPipelineRunStore avec des chemins contenant des espaces.
});
