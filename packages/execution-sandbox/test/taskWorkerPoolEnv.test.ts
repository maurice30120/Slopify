import assert from 'node:assert/strict';
import test from 'node:test';
import { TASK_CONTAINER_ENV } from '../src/taskWorkerPool.js';
import { PI_NATIVE_PROVIDERS } from '@slopify/agent-pi';

/** Le conteneur de tâche doit recevoir la clé API de chaque provider natif Pi configurable en sandbox : le models.json propagé la référence par variable d'environnement, et une clé manquante ferait échouer la sélection à l'exécution (#196). */
test('the task container env forwarding carries the API key of every native Pi provider in the catalog', () => {
  for (const provider of PI_NATIVE_PROVIDERS) {
    assert.ok(TASK_CONTAINER_ENV.includes(provider.apiKeyEnv),
      `${provider.apiKeyEnv} (native Pi provider "${provider.id}") must be forwarded to the task container`);
  }
});
