import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const dir = '/Users/dhuyet/Documents/POC/Slopify/.scratch/slopify-unit-tests';
const issues = dir + '/issues';
const read = f => readFileSync(path.join(issues, f), 'utf8');

const impl = (issueUrl, file) =>
  '/skill:implement Consulte la spec figée du run (context/spec.md dans la sandbox).\n\n' +
  'Ticket complet (texte intégral, source: ' + issueUrl + ') :\n\n' +
  read(file) +
  '\n\nContraintes : ajoute uniquement un fichier de test dédié dans le paquet CLI slopify ' +
  '(même espace de test que les tests existants, style node:test + assert/strict). ' +
  'Ne modifie aucun fichier source de production. Compile et exécute la suite complète du paquet ' +
  '(npm test dans le workspace slopify) jusqu\'au vert avant de conclure. ' +
  'Termine ton message final par exactement une ligne SLOPIFY_RESULT={"status":"succeeded"} ou ' +
  'SLOPIFY_RESULT={"status":"failed","reason":"..."} selon le résultat réel des vérifications.';

const verify =
  '/skill:code-review Effectue les vérifications suivantes sur le résultat intégré du lot :\n\n' +
  '1. Typechecking complet du monorepo (npm run build à la racine).\n' +
  '2. Suite de tests complète du monorepo (npm test à la racine).\n' +
  '3. Revue Standards/Spec depuis le commit de base du run : quatre nouveaux fichiers de tests ' +
  'unitaires dédiés (verdict agent, adaptateur Pi, exécuteur Docker, routage CLI), aucun changement ' +
  'de code de production, conformité à la spec (context/spec.md).\n\n' +
  'Exige les sorties réelles des commandes et les résultats des deux reviewers. Signale toute preuve ' +
  'manquante comme non vérifiée, sans la déduire des commits. Contexte : résultat combiné des quatre ' +
  'tickets de génération de tests. Termine par exactement une ligne ' +
  'SLOPIFY_RESULT={"status":"succeeded"} ou SLOPIFY_RESULT={"status":"failed","reason":"..."} ' +
  'selon le résultat réel.';

const batch = {
  specFile: 'spec.md',
  tasks: [
    {
      id: 'test-agentoutcome',
      prompt: impl('https://github.com/maurice30120/Slopify/issues/54', '01-agentoutcome-tests.md'),
      agent: 'pi',
      dependsOn: [],
      source: 'https://github.com/maurice30120/Slopify/issues/54'
    },
    {
      id: 'test-pi-task-adapter',
      prompt: impl('https://github.com/maurice30120/Slopify/issues/55', '02-pi-task-adapter-tests.md'),
      agent: 'pi',
      dependsOn: [],
      source: 'https://github.com/maurice30120/Slopify/issues/55'
    },
    {
      id: 'test-docker-task-executor',
      prompt: impl('https://github.com/maurice30120/Slopify/issues/56', '03-docker-task-executor-tests.md'),
      agent: 'pi',
      dependsOn: [],
      source: 'https://github.com/maurice30120/Slopify/issues/56'
    },
    {
      id: 'test-cli-routing',
      prompt: impl('https://github.com/maurice30120/Slopify/issues/57', '04-cli-routing-tests.md'),
      agent: 'pi',
      dependsOn: [],
      source: 'https://github.com/maurice30120/Slopify/issues/57'
    },
    {
      id: 'final-verify',
      prompt: verify,
      agent: 'pi',
      dependsOn: ['test-agentoutcome', 'test-pi-task-adapter', 'test-docker-task-executor', 'test-cli-routing'],
      source: 'https://github.com/maurice30120/Slopify/issues/58'
    }
  ]
};

writeFileSync(path.join(dir, 'batch.json'), JSON.stringify(batch, null, 2));
console.log('batch written:', path.join(dir, 'batch.json'));
