import test from 'node:test';

test.todo("catalogs — catalogue de pipelines absent", function testerCatalogsCatalogueDePipelinesAbsent() {
  // TODO : Vérifier un résultat vide sans erreur lorsque .acp/pipelines n'existe pas.
});

test.todo("catalogs — YAML invalide parmi fichiers valides", function testerCatalogsYAMLInvalideParmiFichiersValides() {
  // TODO : Vérifier que l'erreur conserve son chemin et que les autres pipelines restent disponibles.
});

test.todo("catalogs — extensions de fichiers du catalogue", function testerCatalogsExtensionsDeFichiersDuCatalogue() {
  // TODO : Vérifier la lecture de yaml et yml et l'ignorance des autres extensions.
});

test.todo("catalogs — erreur de lecture du dossier pipelines", function testerCatalogsErreurDeLectureDuDossierPipelines() {
  // TODO : Simuler readdir en échec et vérifier le résultat et le diagnostic journalisé.
});

test.todo("catalogs — résolution par titre ou identifiant", function testerCatalogsResolutionParTitreOuIdentifiant() {
  // TODO : Vérifier getPipelineProgramForAgent pour le titre, l'identifiant et une valeur inconnue.
});

test.todo("catalogs — priorité agent configuré sur pipeline", function testerCatalogsPrioriteAgentConfigureSurPipeline() {
  // TODO : Créer une collision de nom et vérifier que resolveWorkspaceAgent choisit l'agent configuré.
});

test.todo("catalogs — suffixe invalid des agents", function testerCatalogsSuffixeInvalidDesAgents() {
  // TODO : Vérifier la normalisation du suffixe d'affichage avant résolution d'un agent.
});

test.todo("catalogs — déduplication des noms d'agents", function testerCatalogsDeduplicationDesNomsDAgents() {
  // TODO : Vérifier que listWorkspaceAgentNames ne répète pas un nom présent dans plusieurs sources.
});

test.todo("catalogs — skill sans frontmatter", function testerCatalogsSkillSansFrontmatter() {
  // TODO : Vérifier que les fichiers sans frontmatter sont ignorés par loadSkillCatalog.
});

test.todo("catalogs — frontmatter incomplet ou invalide", function testerCatalogsFrontmatterIncompletOuInvalide() {
  // TODO : Tester nom absent, description blanche et YAML invalide puis vérifier l'exclusion de ces skills.
});

test.todo("catalogs — frontmatter CRLF", function testerCatalogsFrontmatterCRLF() {
  // TODO : Vérifier le parsing d'une skill avec des fins de lignes Windows.
});

test.todo("catalogs — interdiction invocation automatique booléenne", function testerCatalogsInterdictionInvocationAutomatiqueBooleenne() {
  // TODO : Vérifier que seul le booléen true active disable-model-invocation, sans coercition d'une chaîne.
});

test.todo("catalogs — erreur de lecture d'une skill", function testerCatalogsErreurDeLectureDUneSkill() {
  // TODO : Simuler une lecture impossible et vérifier le diagnostic sans perdre le reste du catalogue.
});

test.todo("catalogs — allowList de skills vide", function testerCatalogsAllowListDeSkillsVide() {
  // TODO : Vérifier que renderSkillsCatalog retourne une chaîne vide pour une liste absente ou vide.
});

test.todo("catalogs — skill demandée manquante", function testerCatalogsSkillDemandeeManquante() {
  // TODO : Vérifier que renderSkillsCatalog lève un diagnostic plutôt qu'un bloc incomplet.
});
