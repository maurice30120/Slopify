import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { loadPiModelSelection, resolvePiModelSelection } from '../src/piNativeCatalog.js';

/** Crée un dépôt temporaire avec une configuration runtime optionnelle. */
async function repository(t: { after(fn: () => Promise<void>): void }, runtimeYaml?: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-pi-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (runtimeYaml !== undefined) {
    await mkdir(path.join(root, '.slopify'), { recursive: true });
    await writeFile(path.join(root, '.slopify', 'runtime.yaml'), runtimeYaml);
  }
  return root;
}

test('without pi configuration the selection falls back to the documented Slopify default, never to a silent agent choice', async t => {
  const repo = await repository(t);
  const selection = await loadPiModelSelection(repo);
  assert.equal(selection.provider.id, 'mistral');
  assert.equal(selection.model.id, 'zai-glm-5-3');
  assert.equal(selection.source, 'default');
});

test('a compatible configured mistral selection is resolved with its native model metadata', async t => {
  const repo = await repository(t, 'workers:\n  size: 10\npi:\n  provider: mistral\n  model: mistral-large-4\n');
  const selection = await loadPiModelSelection(repo);
  assert.equal(selection.provider.id, 'mistral');
  assert.equal(selection.model.id, 'mistral-large-4');
  assert.equal(selection.model.name, 'Mistral Large 4');
  assert.equal(selection.source, 'configured');
});

test('a compatible configured zai selection is resolved as a distinct native provider', async t => {
  const repo = await repository(t, 'pi:\n  provider: zai\n  model: glm-5.3\n');
  const selection = await loadPiModelSelection(repo);
  assert.equal(selection.provider.id, 'zai');
  assert.equal(selection.model.id, 'glm-5.3');
  assert.equal(selection.provider.apiKeyEnv, 'ZAI_API_KEY');
  assert.equal(selection.source, 'configured');
});

test('an incompatible model is rejected with the provider model list, never silently switched', async t => {
  const repo = await repository(t, 'pi:\n  provider: zai\n  model: zai-glm-5-3\n');
  await assert.rejects(loadPiModelSelection(repo), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'pi_model_selection_invalid');
    assert.match(error.message, /zai-glm-5-3/);
    assert.match(error.message, /glm-5\.3/);
    assert.match(error.message, /zai/);
    return true;
  });
});

test('a provider outside the native Pi catalog is rejected with the supported providers', async t => {
  assert.throws(() => resolvePiModelSelection('ollama', 'llama3'), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'pi_model_selection_invalid');
    assert.match(error.message, /ollama/);
    assert.match(error.message, /mistral/);
    assert.match(error.message, /zai/);
    assert.doesNotMatch(error.message, /opencode-go/);
    return true;
  });
});

test('a partial selection is rejected: provider and model must be chosen together', async t => {
  assert.throws(() => resolvePiModelSelection('mistral', undefined), /together/i);
  assert.throws(() => resolvePiModelSelection(undefined, 'zai-glm-5-3'), /together/i);
});

test('a non-string or empty selection value is rejected explicitly', async t => {
  assert.throws(() => resolvePiModelSelection(42, 'zai-glm-5-3'), /provider/i);
  assert.throws(() => resolvePiModelSelection('mistral', ''), /model/i);
});

test('an unknown key inside the pi section is rejected instead of being ignored', async t => {
  const repo = await repository(t, 'pi:\n  provider: mistral\n  model: zai-glm-5-3\n  endpoint: https://local\n');
  await assert.rejects(loadPiModelSelection(repo), /endpoint/);
});

test('a malformed pi section is rejected with an actionable message', async t => {
  const repo = await repository(t, 'pi: mistral\n');
  await assert.rejects(loadPiModelSelection(repo), /pi must be an object/i);
});

test('an unreadable runtime configuration surfaces its own error', async t => {
  const repo = await repository(t, 'mode: [unclosed\n');
  await assert.rejects(loadPiModelSelection(repo), /runtime\.yaml/i);
});
