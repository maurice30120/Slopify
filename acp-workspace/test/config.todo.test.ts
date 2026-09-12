import test from 'node:test';

test.todo("config — JSON de configuration invalide", function testerConfigJSONDeConfigurationInvalide() {
  // TODO : Vérifier un catalogue vide et un diagnostic JSON explicite sans exception non maîtrisée.
});

test.todo("config — racine de configuration non objet", function testerConfigRacineDeConfigurationNonObjet() {
  // TODO : Tester null, tableau et scalaire puis vérifier les valeurs par défaut et erreurs.
});

test.todo("config — agent invalide parmi des agents valides", function testerConfigAgentInvalideParmiDesAgentsValides() {
  // TODO : Vérifier qu'une entrée invalide est diagnostiquée sans supprimer les autres agents valides.
});

test.todo("config — arguments natifs non textuels", function testerConfigArgumentsNatifsNonTextuels() {
  // TODO : Vérifier le rejet d'un tableau args contenant un élément non chaîne.
});

test.todo("config — environnement natif mal formé", function testerConfigEnvironnementNatifMalForme() {
  // TODO : Vérifier le rejet des valeurs env qui ne sont pas des chaînes.
});

test.todo("config — modèle sandbox vide", function testerConfigModeleSandboxVide() {
  // TODO : Tester modèle absent, vide et composé d'espaces puis vérifier le rejet.
});

test.todo("config — effort sandbox inconnu", function testerConfigEffortSandboxInconnu() {
  // TODO : Tester un effort hors liste et vérifier un diagnostic localisé à l'agent.
});

test.todo("config — kit Vibe vide", function testerConfigKitVibeVide() {
  // TODO : Vérifier le rejet d'un kit absent ou vide pour Vibe Sandbox.
});

test.todo("config — configuration OpenCode sur autre agent", function testerConfigConfigurationOpenCodeSurAutreAgent() {
  // TODO : Vérifier que opencodeConfig ne peut pas être attaché à un agent sandbox non OpenCode.
});

test.todo("config — délais ACP invalides", function testerConfigDelaisACPInvalides() {
  // TODO : Tester des types et valeurs hors contrat pour chaque délai et vérifier les diagnostics correspondants.
});

test.todo("config — pipeline désactivé", function testerConfigPipelineDesactive() {
  // TODO : Vérifier que pipeline.enabled false est conservé sans supprimer les agents.
});

test.todo("config — taille maximale instructions invalide", function testerConfigTailleMaximaleInstructionsInvalide() {
  // TODO : Tester les bornes et les types du champ instructionsMaxBytes.
});

test.todo("config — upsert d'un agent existant", function testerConfigUpsertDUnAgentExistant() {
  // TODO : Vérifier le remplacement ciblé de l'agent et la conservation des champs d'enveloppe.
});

test.todo("config — suppression d'un agent absent", function testerConfigSuppressionDUnAgentAbsent() {
  // TODO : Vérifier que removeAgentConfig n'altère aucune autre entrée.
});

test.todo("config — racine de configuration séparée", function testerConfigRacineDeConfigurationSeparee() {
  // TODO : Vérifier que configRoot désigne la source de configuration indépendamment du workspace d'exécution.
});
