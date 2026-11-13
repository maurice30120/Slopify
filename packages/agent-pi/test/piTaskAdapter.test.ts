import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import type { SubprocessResult, TaskAgentContext } from '@slopify/execution';
import { createPiTaskAdapter } from '../src/index.js';

/**
 * Bundle de test minimal de la distribution: inventory.json + skills/engineering,
 * conforme à la forme livrée par #184. Aucun store global de skills n'est lu.
 */
async function miniDistribution(root: string): Promise<string> {
  const workflowResourcesRoot = path.join(root, 'distribution');
  for (const relative of [
    'skills/engineering/implement/SKILL.md',
    'skills/engineering/tdd/SKILL.md',
    'skills/engineering/code-review/SKILL.md',
  ]) {
    await mkdir(path.join(workflowResourcesRoot, path.dirname(relative)), { recursive: true });
    await writeFile(path.join(workflowResourcesRoot, relative), `Content of ${path.basename(path.dirname(relative))} workflow skill.`);
  }
  await writeFile(path.join(workflowResourcesRoot, 'inventory.json'), JSON.stringify({ roles: {
    implementer: { entry: 'skills/engineering/implement/SKILL.md', dependencies: [{ path: 'skills/engineering/tdd/SKILL.md' }] },
    reviewer: { entry: 'skills/engineering/code-review/SKILL.md', dependencies: [] },
  } }));
  return workflowResourcesRoot;
}

/**
 * Fixture d'adaptateur Pi simulée : chaque commande sbx est feintée sans réseau,
 * sans Docker et sans appel fournisseur ; les fichiers générés sont relus pour
 * vérifier la propagation de la sélection provider/modèle.
 */
async function fixture(t: { after(fn: () => Promise<void>): void }, runtimeYaml?: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-pi-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  if (runtimeYaml !== undefined) {
    await mkdir(path.join(workspace, '.slopify'), { recursive: true });
    await writeFile(path.join(workspace, '.slopify', 'runtime.yaml'), runtimeYaml);
  }
  const workflowResourcesRoot = await miniDistribution(root);
  const skillsStore = path.join(root, 'official-skills');
  await mkdir(path.join(skillsStore, 'code-review'), { recursive: true });
  await writeFile(path.join(skillsStore, 'code-review', 'SKILL.md'), 'Official fixed smell baseline.');
  const resultDirectory = path.join(root, 'results');
  await mkdir(resultDirectory, { recursive: true });
  const contextDirectory = path.join(resultDirectory, 'context');
  await mkdir(contextDirectory, { recursive: true });
  await writeFile(path.join(contextDirectory, 'harness.txt'), 'Shared harness context.');
  const calls: string[][] = [];
  const copied: Record<string, string> = {};
  const command = async (args: string[]): Promise<SubprocessResult> => {
    calls.push(args);
    const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
    if (args[0] === 'kit') return ok('{}');
    if (args[0] === 'mkdir') return ok();
    if (args[0] === 'cp') {
      const source = args[1];
      copied[path.basename(source)] = await readFile(source, 'utf8');
      return ok();
    }
    if (args[0] === 'exec') {
      if (args.includes('pi') && args.includes('--print')) {
        return ok(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Pi run report\nSLOPIFY_RESULT={\"status\":\"succeeded\"}' }] } }) + '\n');
      }
      if (args.some(value => value.includes('npm root -g'))) return ok('/opt/pi/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts\n');
      return ok();
    }
    throw new Error(`Unhandled sbx ${args.join(' ')}`);
  };
  const context: TaskAgentContext = {
    runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1', agent: 'pi',
    workspacePath: workspace, specFile: path.join(contextDirectory, 'spec.md'),
    prompt: '$implement\nApproved ticket', taskBaseCommit: 'base', runBaseCommit: 'base',
    resultDirectory, sandboxName: 'sandbox-1', containerWorkspacePath: '/workspace',
    containerContextPath: contextDirectory, skillsStore, workflowResourcesRoot, command,
  };
  return { root, workflowResourcesRoot, workspace, resultDirectory, calls, copied, context };
}

function piInvocation(calls: string[][]): string[] {
  return calls.find(args => args.includes('pi') && args.includes('--print'))!;
}

test('default selection propagates the native mistral provider and model to kit, config and invocation', async t => {
  const f = await fixture(t);
  const adapter = createPiTaskAdapter();
  const preparation = await adapter.prepare(f.context);
  assert.equal(preparation.createTarget.endsWith('pi-kit'), true);
  const kit = JSON.parse(await readFile(path.join(preparation.createTarget, 'spec.yaml'), 'utf8'));
  assert.equal(kit.name, 'slopify-pi-mistral');
  assert.deepEqual(kit.permissions.network.allow, ['api.mistral.ai:443']);
  assert.equal(kit.credentials[0].service, 'mistral');
  assert.equal(kit.credentials[0].apiKey.name, 'MISTRAL_API_KEY');
  assert.equal(kit.credentials[0].apiKey.inject[0].domain, 'api.mistral.ai');
  const run = await adapter.run(f.context);
  assert.equal(run.exitCode, 0);
  const models = JSON.parse(f.copied['models.json']).providers;
  assert.deepEqual(Object.keys(models), ['mistral'], 'the generated config exposes exactly the selected native provider');
  assert.equal(models.mistral.baseUrl, 'https://api.mistral.ai');
  assert.equal(models.mistral.api, 'mistral-conversations');
  assert.equal(models.mistral.apiKey, '${MISTRAL_API_KEY}');
  assert.equal(models.mistral.models.length, 1);
  assert.equal(models.mistral.models[0].id, 'zai-glm-5-3');
  assert.equal(models.mistral.models[0].thinkingLevelMap.max, 'max');
  const invocation = piInvocation(f.calls);
  const providerIndex = invocation.indexOf('--provider');
  assert.equal(invocation[providerIndex + 1], 'mistral');
  assert.equal(invocation[invocation.indexOf('--model') + 1], 'zai-glm-5-3');
  assert.match(f.copied['harness.md'], /provider mistral, model zai-glm-5-3/);
  assert.match(run.report, /Pi selection: provider=mistral, model=zai-glm-5-3/);
});

test('reviewer instructions reference the distributed skill rather than embedding a second copy', async t => {
  const f = await fixture(t);
  const adapter = createPiTaskAdapter();
  await adapter.prepare(f.context);
  await adapter.run(f.context);
  for (const axis of ['standards.md', 'spec.md']) {
    assert.match(f.copied[axis], /skills\/engineering\/code-review\/SKILL\.md/);
    assert.doesNotMatch(f.copied[axis], /Official fixed smell baseline\./);
  }
  assert.match(f.copied['harness.md'], /skills\/engineering/);
  assert.doesNotMatch(f.copied['harness.md'], /official-skills/, 'the harness never references the global skills store');
});

test('prepare mounts the distributed skills directory readonly and pi uses it as its only skill source', async t => {
  const f = await fixture(t);
  const adapter = createPiTaskAdapter();
  const preparation = await adapter.prepare(f.context);
  assert.deepEqual(preparation.createMounts, [`${path.join(f.workflowResourcesRoot, 'skills', 'engineering')}:ro`]);
  await adapter.run(f.context);
  const invocation = piInvocation(f.calls);
  const skillIndex = invocation.indexOf('--skill');
  assert.equal(skillIndex > -1, true);
  assert.equal(invocation[skillIndex + 1], path.join(f.workflowResourcesRoot, 'skills', 'engineering'));
});

test('a missing workflow resources root fails explicitly without any fallback or sbx command', async t => {
  const f = await fixture(t);
  const adapter = createPiTaskAdapter();
  const context = { ...f.context, workflowResourcesRoot: undefined };
  await assert.rejects(adapter.prepare(context), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'pi_workflow_resources_missing');
    assert.match(error.message, /workflow resources/);
    return true;
  });
  assert.equal(f.calls.length, 0, 'no sbx command runs when the distribution root is absent');
  const run = await adapter.run(context);
  assert.equal(run.exitCode, 1);
  assert.ok(run.diagnostics.some(diagnostic => diagnostic.code === 'pi_workflow_resources_missing'));
  assert.equal(f.calls.length, 0, 'no silent fallback happens during the run either');
});

test('an invalid distributed bundle fails explicitly before any sbx command', async t => {
  const f = await fixture(t);
  const broken = path.join(f.root, 'broken-distribution');
  await mkdir(path.join(broken, 'skills/engineering/implement'), { recursive: true });
  await writeFile(path.join(broken, 'skills/engineering/implement/SKILL.md'), 'implementation');
  await writeFile(path.join(broken, 'inventory.json'), JSON.stringify({ roles: {
    implementer: { entry: 'skills/engineering/implement/SKILL.md', dependencies: [{ path: 'skills/engineering/tdd/SKILL.md' }] },
    reviewer: { entry: 'skills/engineering/code-review/SKILL.md', dependencies: [] },
  } }));
  const adapter = createPiTaskAdapter();
  const context = { ...f.context, workflowResourcesRoot: broken };
  await assert.rejects(adapter.prepare(context), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'pi_workflow_resources_invalid');
    assert.match(error.message, /tdd\/SKILL\.md/);
    return true;
  });
  assert.equal(f.calls.length, 0);
  const run = await adapter.run(context);
  assert.equal(run.exitCode, 1);
  assert.ok(run.diagnostics.some(diagnostic => diagnostic.code === 'pi_workflow_resources_invalid' && /tdd\/SKILL\.md/.test(diagnostic.message)));
  assert.equal(f.calls.length, 0);
});

test('a configured compatible mistral selection replaces the default couple everywhere', async t => {
  const f = await fixture(t, 'pi:\n  provider: mistral\n  model: mistral-large-4\n');
  const adapter = createPiTaskAdapter();
  await adapter.prepare(f.context);
  const run = await adapter.run(f.context);
  assert.equal(run.exitCode, 0);
  const models = JSON.parse(f.copied['models.json']).providers;
  assert.equal(models.mistral.models[0].id, 'mistral-large-4');
  assert.equal(models.mistral.models[0].name, 'Mistral Large 4');
  const invocation = piInvocation(f.calls);
  assert.equal(invocation[invocation.indexOf('--provider') + 1], 'mistral');
  assert.equal(invocation[invocation.indexOf('--model') + 1], 'mistral-large-4');
  assert.match(run.report, /Pi selection: provider=mistral, model=mistral-large-4/);
  assert.match(run.report, /configured in \.slopify\/runtime\.yaml/);
});

test('a configured compatible zai selection is a distinct native provider with its own endpoint and credential', async t => {
  const f = await fixture(t, 'pi:\n  provider: zai\n  model: glm-5.3\n');
  const adapter = createPiTaskAdapter();
  const preparation = await adapter.prepare(f.context);
  const kit = JSON.parse(await readFile(path.join(preparation.createTarget, 'spec.yaml'), 'utf8'));
  assert.equal(kit.name, 'slopify-pi-zai');
  assert.deepEqual(kit.permissions.network.allow, ['api.z.ai:443']);
  assert.equal(kit.credentials[0].service, 'zai');
  assert.equal(kit.credentials[0].apiKey.name, 'ZAI_API_KEY');
  assert.equal(kit.credentials[0].apiKey.inject[0].domain, 'api.z.ai');
  const run = await adapter.run(f.context);
  assert.equal(run.exitCode, 0);
  const models = JSON.parse(f.copied['models.json']).providers;
  assert.deepEqual(Object.keys(models), ['zai']);
  assert.equal(models.zai.baseUrl, 'https://api.z.ai/api/coding/paas/v4');
  assert.equal(models.zai.api, 'openai-completions');
  assert.equal(models.zai.apiKey, '${ZAI_API_KEY}');
  assert.equal(models.zai.models[0].id, 'glm-5.3');
  assert.equal(models.zai.models[0].compat.supportsStore, false);
  const invocation = piInvocation(f.calls);
  assert.equal(invocation[invocation.indexOf('--provider') + 1], 'zai');
  assert.equal(invocation[invocation.indexOf('--model') + 1], 'glm-5.3');
  assert.match(run.report, /Pi selection: provider=zai, model=glm-5\.3/);
});

test('an incompatible selection fails before any sandbox or model request, without fallback', async t => {
  const f = await fixture(t, 'pi:\n  provider: zai\n  model: zai-glm-5-3\n');
  const adapter = createPiTaskAdapter();
  await assert.rejects(adapter.prepare(f.context), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'pi_model_selection_invalid');
    assert.match(error.message, /zai-glm-5-3/);
    assert.match(error.message, /glm-5\.3/);
    return true;
  });
  assert.equal(f.calls.length, 0, 'no sbx command runs when the selection is invalid');
  await assert.rejects(adapter.run(f.context), /not offered by the native Pi provider "zai".*glm-5\.3/s);
  assert.equal(f.calls.length, 0, 'no model request is ever issued for an invalid selection');
});

test('a provider outside the native catalog fails with the supported providers before any command', async t => {
  const f = await fixture(t, 'pi:\n  provider: ollama\n  model: llama3\n');
  const adapter = createPiTaskAdapter();
  await assert.rejects(adapter.prepare(f.context), /not a natively supported Pi provider.*mistral, zai/);
  assert.equal(f.calls.length, 0);
});

test('the readiness check verifies every resolved resource of the distribution and the readonly mount', async t => {
  const f = await fixture(t);
  const adapter = createPiTaskAdapter();
  await adapter.prepare(f.context);
  await adapter.run(f.context);
  const readiness = f.calls.find(args => args.some(value => value.includes('findmnt')))!;
  const script = readiness.join(' ');
  assert.match(script, /skills\/engineering\/implement\/SKILL\.md/);
  assert.match(script, /skills\/engineering\/tdd\/SKILL\.md/);
  assert.match(script, /skills\/engineering\/code-review\/SKILL\.md/);
  assert.match(script, /findmnt/);
});
