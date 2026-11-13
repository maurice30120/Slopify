import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentRpcProcess, AgentRpcSpawnRequest, SubprocessResult, TaskAgentContext } from '@slopify/execution';
import { createPiTaskAdapter } from '../src/index.js';

/**
 * Fixture d'adaptateur Pi simulée : chaque commande sbx et chaque session RPC est
 * feintée sans réseau, sans Docker et sans appel fournisseur ; le rôle vient du
 * chemin --append-system-prompt (harness.md = implémenteur, reviewer.md = reviewer).
 * Les fichiers générés sont relus pour vérifier la propagation de la sélection
 * provider/modèle, jusqu'à chaque invocation RPC.
 */
interface FakeRpcScenario {
  /** Verdicts émis par le reviewer, cycle après cycle. */
  verdicts?: string[];
  /** Verdict final déclaré par l'implémenteur dans son message. */
  implementerVerdict?: 'succeeded' | 'failed';
  /** L'extension subagent officielle manque dans le conteneur. */
  extensionMissing?: boolean;
  /** Aucun transport RPC interactif n'est fourni au contexte. */
  withoutRpcTransport?: boolean;
}

interface RpcChannelRecord {
  role: 'implementer' | 'reviewer';
  args: string[];
  prompts: string[];
  closes: number;
}

async function fixture(t: { after(fn: () => Promise<void>): void }, runtimeYaml?: string, scenario: FakeRpcScenario = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-pi-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  if (runtimeYaml !== undefined) {
    await mkdir(path.join(workspace, '.slopify'), { recursive: true });
    await writeFile(path.join(workspace, '.slopify', 'runtime.yaml'), runtimeYaml);
  }
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
      if (args.includes('git')) return ok();
      if (args.some(value => value.includes('npm root -g'))) {
        return scenario.extensionMissing
          ? { exitCode: 1, stdout: '', stderr: 'extension missing' }
          : ok('/opt/pi/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts\n');
      }
      return ok();
    }
    throw new Error(`Unhandled sbx ${args.join(' ')}`);
  };
  // Faux transport RPC : le rôle vient du chemin --append-system-prompt ; le faux
  // processus répond au protocole JSONL sans jamais toucher un réseau ni un fournisseur.
  const rpcChannels: RpcChannelRecord[] = [];
  let reviewerPass = 0;
  const spawnRpc = (request: AgentRpcSpawnRequest): AgentRpcProcess => {
    const promptPath = request.args[request.args.indexOf('--append-system-prompt') + 1];
    const role: 'implementer' | 'reviewer' = promptPath.endsWith('reviewer.md') ? 'reviewer' : 'implementer';
    const record: RpcChannelRecord = { role, args: request.args, prompts: [], closes: 0 };
    rpcChannels.push(record);
    if (role === 'reviewer') reviewerPass += 1;
    const pass = reviewerPass;
    let exited = false;
    const emit = (value: unknown) => request.onRecord(JSON.stringify(value));
    return {
      writeLine: (line: string) => {
        let command_: { id?: string; type?: string; message?: unknown };
        try { command_ = JSON.parse(line); } catch { return; }
        if (command_.type !== 'prompt') return;
        record.prompts.push(String(command_.message ?? ''));
        emit({ id: command_.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
        if (role === 'implementer') {
          const verdict = scenario.implementerVerdict ?? 'succeeded';
          const text = verdict === 'succeeded' ? 'Pi run report\nSLOPIFY_RESULT={"status":"succeeded"}'
            : 'Blocked by final validation\nSLOPIFY_RESULT={"status":"failed","reason":"final validation failed"}';
          emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });
          emit({ type: 'agent_settled' });
          return;
        }
        const verdicts = scenario.verdicts ?? ['SLOPIFY_REVIEW={"verdict":"approved"}'];
        const verdict = verdicts[Math.min(pass, verdicts.length) - 1];
        emit({ type: 'tool_execution_end', toolName: 'subagent', isError: false, result: { details: { mode: 'parallel', results: [
          { agent: 'standards', exitCode: 0, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Independent Standards findings' }] }] },
          { agent: 'spec', exitCode: 0, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Independent Spec findings' }] }] },
        ] } } });
        emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Independent review report\n' + verdict }] } });
        emit({ type: 'agent_settled' });
      },
      close: async () => {
        record.closes += 1;
        if (!exited) { exited = true; request.onExit({ exitCode: 0, stderrTail: '' }); }
        return { exitCode: 0, stderrTail: '' };
      },
      get alive() { return !exited; },
      describe: () => `fake pi rpc ${role}`,
    };
  };
  const context: TaskAgentContext = {
    runId: 'run-1', taskId: 'task-1', attemptId: 'attempt-1', agent: 'pi',
    workspacePath: workspace, specFile: path.join(contextDirectory, 'spec.md'),
    prompt: '$implement\nApproved ticket', taskBaseCommit: 'base', runBaseCommit: 'base',
    resultDirectory, sandboxName: 'sandbox-1', containerWorkspacePath: '/workspace',
    containerContextPath: contextDirectory, skillsStore, command,
    ...(scenario.withoutRpcTransport ? {} : { spawnRpc }),
  };
  return { root, workspace, resultDirectory, calls, copied, rpcChannels, context };
}

test('default selection propagates the native mistral provider and model to kit, config and every RPC invocation', async t => {
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
  // Transport : chaque session RPC porte la même sélection native, en mode rpc interactif, jamais en mode print.
  assert.ok(f.rpcChannels.length >= 2, 'implementer and reviewer run as separate RPC sessions');
  assert.ok(f.rpcChannels.some(channel => channel.role === 'implementer'));
  assert.ok(f.rpcChannels.some(channel => channel.role === 'reviewer'));
  for (const channel of f.rpcChannels) {
    assert.equal(channel.args[channel.args.indexOf('--provider') + 1], 'mistral');
    assert.equal(channel.args[channel.args.indexOf('--model') + 1], 'zai-glm-5-3');
    assert.equal(channel.args[channel.args.indexOf('--mode') + 1], 'rpc');
    assert.equal(channel.args.includes('--print'), false);
    assert.equal(channel.args.includes('--append-system-prompt'), true);
  }
  assert.equal(f.calls.some(args => args.includes('pi') && args.includes('--print')), false, 'no one-shot print invocation survives');
  assert.match(f.copied['harness.md'], /provider mistral, model zai-glm-5-3/);
  assert.match(f.copied['reviewer.md'], /read-only session that never shares the implementer conversation/);
  assert.match(f.copied['reviewer.md'], /Delegated agents are named standards and spec/);
  assert.match(run.report, /Pi selection: provider=mistral, model=zai-glm-5-3/);
});

test('a reviewer rejection cycles a correction in the same implementer RPC session', async t => {
  const f = await fixture(t, undefined, { verdicts: ['SLOPIFY_REVIEW={"verdict":"rejected","reason":"standards breach"}', 'SLOPIFY_REVIEW={"verdict":"approved"}'] });
  const adapter = createPiTaskAdapter();
  await adapter.prepare(f.context);
  const run = await adapter.run(f.context);
  assert.equal(run.exitCode, 0);
  const implementer = f.rpcChannels.filter(channel => channel.role === 'implementer');
  assert.equal(implementer.length, 1, 'exactly one persistent implementer RPC session across the correction cycle');
  assert.equal(implementer[0].prompts.length, 2, 'the correction arrives as a new message in the same session');
  assert.match(implementer[0].prompts[0], /Approved ticket/);
  assert.match(implementer[0].prompts[1], /standards breach/);
  const reviewers = f.rpcChannels.filter(channel => channel.role === 'reviewer');
  assert.equal(reviewers.length, 2, 'a fresh reviewer RPC session per pass');
  assert.equal(reviewers[0].prompts.length, 1);
  assert.equal(reviewers[1].prompts.length, 1);
  assert.match(reviewers[0].prompts[0], /Independent review, cycle 1/);
  assert.match(reviewers[1].prompts[0], /Independent review, cycle 2/);
  assert.ok(reviewers.every(channel => channel.closes >= 1), 'each reviewer session is closed after its reports');
  assert.match(run.report, /Independent review report/);
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
  assert.ok(f.rpcChannels.length >= 1);
  for (const channel of f.rpcChannels) {
    assert.equal(channel.args[channel.args.indexOf('--provider') + 1], 'mistral');
    assert.equal(channel.args[channel.args.indexOf('--model') + 1], 'mistral-large-4');
    assert.equal(channel.args[channel.args.indexOf('--mode') + 1], 'rpc');
  }
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
  assert.ok(f.rpcChannels.length >= 1);
  for (const channel of f.rpcChannels) {
    assert.equal(channel.args[channel.args.indexOf('--provider') + 1], 'zai');
    assert.equal(channel.args[channel.args.indexOf('--model') + 1], 'glm-5.3');
    assert.equal(channel.args[channel.args.indexOf('--mode') + 1], 'rpc');
  }
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

test('an execution environment without an interactive RPC transport fails explicitly, without print fallback', async t => {
  const f = await fixture(t, undefined, { withoutRpcTransport: true });
  const adapter = createPiTaskAdapter();
  await adapter.prepare(f.context);
  const run = await adapter.run(f.context);
  assert.equal(run.exitCode, 1);
  const diagnostic = run.diagnostics.find(d => d.code === 'pi_rpc_unavailable');
  assert.ok(diagnostic, 'the missing transport is an explicit diagnostic');
  assert.match(diagnostic!.message, /native RPC transport/);
  assert.match(diagnostic!.message, /No silent fallback/);
  assert.equal(f.calls.some(args => args.includes('pi') && args.includes('--print')), false, 'no silent one-shot print fallback');
});

test('a missing subagent extension fails the workflow before any RPC session starts', async t => {
  const f = await fixture(t, undefined, { extensionMissing: true });
  const adapter = createPiTaskAdapter();
  await adapter.prepare(f.context);
  const run = await adapter.run(f.context);
  assert.equal(run.exitCode, 1);
  assert.ok(run.diagnostics.some(d => d.code === 'pi_subagent_unavailable'));
  assert.equal(f.rpcChannels.length, 0, 'no RPC session starts without the delegation extension');
  assert.equal(f.calls.some(args => args.includes('pi') && args.includes('--print')), false);
});
