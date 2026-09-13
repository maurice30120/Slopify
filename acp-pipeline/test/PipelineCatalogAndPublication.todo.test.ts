import test from 'node:test';

test.todo("PipelineCatalogAndPublication — instructions trop volumineuses", function testerPipelineCatalogAndPublicationInstructionsTropVolumineuses() {
  // TODO : Simuler un fichier juste à la limite puis au-delà et vérifier le contrôle de taille du catalogue.
});

test.todo("PipelineCatalogAndPublication — instructions introuvables", function testerPipelineCatalogAndPublicationInstructionsIntrouvables() {
  // TODO : Vérifier le diagnostic de lecture avec le chemin concerné et sans programme partiellement valide.
});

test.todo("PipelineCatalogAndPublication — publication sans artefact concerné", function testerPipelineCatalogAndPublicationPublicationSansArtefactConcerne() {
  // TODO : Vérifier qu'aucun fichier n'est créé en absence de spécification et de Ticket Graph.
});

test.todo("PipelineCatalogAndPublication — publication de tickets structurés", function testerPipelineCatalogAndPublicationPublicationDeTicketsStructures() {
  // TODO : Vérifier la conservation des identifiants, blockers et critères de validation dans les fichiers Markdown.
});

test.todo("PipelineCatalogAndPublication — titres de tickets avec accents", function testerPipelineCatalogAndPublicationTitresDeTicketsAvecAccents() {
  // TODO : Vérifier la génération de noms de fichiers stables pour des titres accentués et contenant de la ponctuation.
});

test.todo("PipelineCatalogAndPublication — section frontier distincte des tickets", function testerPipelineCatalogAndPublicationSectionFrontierDistincteDesTickets() {
  // TODO : Vérifier qu'une section Markdown Frontier n'est pas incluse dans le corps du dernier ticket.
});

test.todo("PipelineCatalogAndPublication — préservation des fichiers non générés", function testerPipelineCatalogAndPublicationPreservationDesFichiersNonGeneres() {
  // TODO : Vérifier qu'une republication conserve les fichiers étrangers au motif des tickets générés.
});

test.todo("PipelineCatalogAndPublication — erreur d'écriture pendant publication", function testerPipelineCatalogAndPublicationErreurDEcriturePendantPublication() {
  // TODO : Simuler un échec du système de fichiers et vérifier sa remontée au demandeur sans succès fictif.
});
