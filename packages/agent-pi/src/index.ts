import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { TaskAgentAdapter, TaskAgentContext, AgentRpcProcess } from '@slopify/execution';
import type { TaskDiagnostic } from '@slopify/execution';
import { loadPiModelSelection, PI_NATIVE_PROVIDERS, type PiModelSelection } from './piNativeCatalog.js';
import { runPiRpcWorkflow, MAX_REVIEW_CYCLES, type PiReviewOutcome, type PiRpcWorkflowResult } from './piRpcWorkflow.js';
import type { PiRpcChannel, PiRpcChannelFactory } from './piRpcSession.js';

export { PI_NATIVE_PROVIDERS } from './piNativeCatalog.js';
export { runPiRpcWorkflow, MAX_REVIEW_CYCLES } from './piRpcWorkflow.js';
export type { PiReviewOutcome, PiRpcWorkflowOptions, PiRpcWorkflowResult } from './piRpcWorkflow.js';
export type { PiRpcChannel, PiRpcChannelFactory, PiRpcSession, PiRpcTurn } from './piRpcSession.js';
export { redactSecrets, type PiWorkflowEvent } from './piRpcEvidence.js';

/** L'image Pi exige la configuration explicite du provider sélectionné et l'exemple officiel de délégation. */
export function createPiTaskAdapter(): TaskAgentAdapter {
  return {
    agent: 'pi',
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
    async prepare(context) {
      const selection = await loadPiModelSelection(context.workspacePath);
      const kitPath = path.join(context.resultDirectory, 'pi-kit');
      await mkdir(kitPath, { recursive: true });
      await writeFile(path.join(kitPath, 'spec.yaml'), JSON.stringify({
        schemaVersion: '2', kind: 'sandbox', name: `slopify-pi-${selection.provider.id}`,
        displayName: `Slopify Pi with ${selection.provider.name}`,
        description: `Pi task execution with proxy-managed ${selection.provider.name} credentials`,
        sandbox: { image: 'docker.io/sbx/pi-image:latest', entrypoint: ['pi'] },
        agentInstructions: { filename: 'AGENTS.md' },
        permissions: { network: { allow: [`${providerHost(selection)}:443`] } },
        credentials: [{ service: selection.provider.credentialService, apiKey: {
          name: selection.provider.apiKeyEnv, proxyManaged: true,
          inject: [{ domain: providerHost(selection), header: 'Authorization', format: 'Bearer %s' }],
        } }],
        environment: { variables: { PI_OFFLINE: '1', PI_TELEMETRY: '0' } },
      }, null, 2));
      const validation = await context.command(['kit', 'validate', kitPath, '--json']);
      if (validation.exitCode !== 0) throw new Error(`Pi kit validation failed: ${validation.stderr || validation.stdout}`);
      return { createTarget: kitPath, createMounts: [`${context.skillsStore}:ro`] };
    },
/**
 * Exécute le workflow Pi en RPC natif : session implémenteur persistante pour la
 * tentative, sessions reviewer indépendantes neuves à chaque passage, cycles de
 * correction dans la même conversation. Aucun repli vers l'invocation one-shot
 * `pi --mode json --print` : le transport RPC interactif est exigé explicitement.
 */
    async run(context) {
      const selection = await loadPiModelSelection(context.workspacePath);
      const skillsPath = shellQuote(context.skillsStore);
      const readiness = await context.command(['exec', context.sandboxName, 'sh', '-c',
        `set -eu; for skill in implement tdd code-review; do test -r ${skillsPath}/"$skill"/SKILL.md; done; ` +
        `options=$(findmnt -n -o OPTIONS -T ${skillsPath}); case ",$options," in *,ro,*) ;; *) echo "Official skills are writable" >&2; exit 1;; esac; pi --version`]);
      if (readiness.exitCode !== 0) {
        return { exitCode: readiness.exitCode, report: readiness.stderr, diagnostics: [{ code: 'pi_capability',
          message: readiness.stderr || 'Pi and the readonly official skill resources must be available.' }] };
      }
      const extension = await context.command(['exec', context.sandboxName, 'sh', '-lc',
        'root=$(npm root -g) && file="$root/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts" && test -r "$file" && test -r "${file%/*}/agents.ts" && printf "%s\\n" "$file"']);
      const extensionPath = extension.stdout.trim().split('\n').at(-1);
      if (extension.exitCode !== 0 || !extensionPath?.startsWith('/') || !extensionPath.endsWith('/subagent/index.ts')) {
        return { exitCode: 1, report: '', diagnostics: [{ code: 'pi_subagent_unavailable',
          message: 'Pi requires the official examples/extensions/subagent extension and its agents.ts resource in the installed Pi package.' }] };
      }
      if (!context.spawnRpc) {
        return { exitCode: 1, report: '', diagnostics: [{ code: 'pi_rpc_unavailable',
          message: 'The Pi agent workflow requires the native RPC transport (interactive stdio); this execution environment provides none. No silent fallback to one-shot print mode.' }] };
      }
      const configPath = path.join(context.resultDirectory, 'pi-config');
      const containerConfig = '/tmp/slopify-pi-config';
      await mkdir(path.join(configPath, 'agents'), { recursive: true });
      await writeFile(path.join(configPath, 'models.json'), JSON.stringify({ providers: {
        [selection.provider.id]: {
          baseUrl: selection.provider.baseUrl, api: selection.provider.api, apiKey: `\${${selection.provider.apiKeyEnv}}`,
          models: [selection.model],
        },
      } }, null, 2));
      const officialReview = await readFile(path.join(context.skillsStore, 'code-review', 'SKILL.md'), 'utf8');
      for (const axis of ['standards', 'spec'] as const) {
        await writeFile(path.join(configPath, 'agents', `${axis}.md`), reviewerRole(axis, context, officialReview));
      }
      await writeFile(path.join(configPath, 'reviewer.md'), reviewerHarness(context));
      const harnessPath = path.join(configPath, 'harness.md');
      const sharedHarness = await readFile(path.join(context.containerContextPath, 'harness.txt'), 'utf8');
      const evidenceDirectory = path.dirname(context.containerContextPath);
      await writeFile(harnessPath, [sharedHarness,
        `Harness context for task ${context.taskId}. Preserve the supplied user prompt verbatim.`,
        `Read the complete frozen specification at ${context.containerContextPath}/spec.md.`,
        `Task baseline: ${context.taskBaseCommit}. Run baseline: ${context.runBaseCommit}.`,
        `Official skills and all their resources are mounted readonly at ${context.skillsStore}.`,
        `Effective model selection for this task and every delegated subagent: provider ${selection.provider.id}, model ${selection.model.id} (source: ${selection.source === 'configured' ? 'configured in .slopify/runtime.yaml' : 'Slopify default'}).`,
        `Follow implement with TDD at the approved public seams; validate, then commit when green. Do not trigger the independent review yourself: this harness runs it in a separate read-only session and sends its findings back into this same conversation as new messages; correct every finding, revalidate and commit before the next review.`,
        `Subagent delegation always carries the complete task parameter: single mode is {agent, task}, parallel mode is {tasks: [{agent, task}]}, chain mode is {chain: [{agent, task}]}. A call missing task is invalid and answers "Invalid parameters. Provide exactly one mode"; fix the call shape instead of repeating it.`,
        `Actual execution stdout and stderr are streamed to ${evidenceDirectory}/stdout.log and ${evidenceDirectory}/stderr.log; commands at ${evidenceDirectory}/commands.jsonl. Keep them intact as evidence for the reviews.`,
        `Read repository AGENTS.md and every applicable standard before implementation.`,
        `Report final validations honestly.`,
      ].join('\n'));
      const created = await context.command(['exec', context.sandboxName, 'mkdir', '-p', `${containerConfig}/agents`]);
      if (created.exitCode !== 0) throw new Error(`Cannot create Pi configuration directory: ${created.stderr}`);
      for (const relative of ['models.json', 'harness.md', 'reviewer.md', 'agents/standards.md', 'agents/spec.md']) {
        const copied = await context.command(['cp', path.join(configPath, relative), `${context.sandboxName}:${containerConfig}/${relative}`]);
        if (copied.exitCode !== 0) throw new Error(`Cannot provide Pi ${relative}: ${copied.stderr}`);
      }
      // Transport RPC : une seule fabrique, une session par rôle ; la sélection provider/modèle est identique pour l'implémenteur et le reviewer.
      const openChannel: PiRpcChannelFactory = session => {
        const process: AgentRpcProcess = context.spawnRpc!({
          args: rpcInvocation(context, selection, extensionPath, containerConfig, session.role),
          onRecord: session.onRecord,
          onStderr: session.onStderr,
          onExit: session.onExit,
          signal: context.signal,
        });
        return {
          writeLine: line => process.writeLine(line),
          close: () => process.close(),
          get alive() { return process.alive; },
          describe: () => process.describe(),
        };
      };
      const workflow = await runPiRpcWorkflow({
        runId: context.runId, taskId: context.taskId, attemptId: context.attemptId,
        resultDirectory: context.resultDirectory, signal: context.signal,
        openChannel,
        initialMessage: context.prompt,
        reviewMessage: (cycle, previous) => reviewMessage(context, cycle, previous),
        correctionMessage: review => correctionMessage(review),
        verifyReadyForReview: async () => {
          const status = await context.command(['exec', context.sandboxName, 'git', 'status', '--porcelain', '--untracked-files=all']);
          if (status.exitCode !== 0 || status.stdout.trim()) throw new Error('Cannot review: the task workspace must be clean and committed before review.');
        },
      });
      const selectionTrace = `Pi selection: provider=${selection.provider.id}, model=${selection.model.id} `
        + `(${selection.source === 'configured' ? 'configured in .slopify/runtime.yaml' : 'Slopify default; configure pi.provider and pi.model in .slopify/runtime.yaml to change it'}).`;
      return { exitCode: workflow.exitCode, report: [selectionTrace, workflow.report].filter(Boolean).join('\n\n'), diagnostics: workflow.diagnostics };
    },
  };
}

/** Hôte réseau du provider sélectionné : seule destination autorisée par le kit sandbox. */
function providerHost(selection: PiModelSelection): string {
  return new URL(selection.provider.baseUrl).host;
}

/** Invocation sbx de la session RPC Pi : même sélection provider/modèle et même configuration pour l'implémenteur et le reviewer ; le rôle ne change que le brief système (harness.md ou reviewer.md), jamais le transport ni le mode. */
function rpcInvocation(context: TaskAgentContext, selection: PiModelSelection, extensionPath: string, containerConfig: string, role: 'implementer' | 'reviewer'): string[] {
  return ['exec', '-i', '-w', context.containerWorkspacePath,
    '-e', `PI_CODING_AGENT_DIR=${containerConfig}`, context.sandboxName,
    'pi', '--extension', extensionPath, '--offline', '--approve',
    '--provider', selection.provider.id, '--model', selection.model.id,
    '--skill', context.skillsStore,
    '--append-system-prompt', `${containerConfig}/${role === 'implementer' ? 'harness.md' : 'reviewer.md'}`,
    '--mode', 'rpc'];
}

/** Brief de la session reviewer neuve pour ce passage : revue du diff complet, délégation parallèle des deux axes, verdict explicite unique. */
function reviewMessage(context: TaskAgentContext, cycle: number, previous: PiReviewOutcome[]): string {
  const earlier = previous.map(review => `- Cycle ${review.cycle} returned ${review.verdict}${review.reason ? `: ${review.reason}` : ''}. Findings so far: ${review.findings}`).join('\n');
  return `Independent review, cycle ${cycle}, of the complete ticket diff (${context.taskBaseCommit}...HEAD).\n` +
    `Delegate the Standards and Spec reviews now in one parallel subagent call ({tasks: [{agent, task}, {agent, task}]}); this is a read-only review, never edit or commit.\n` +
    (earlier ? `Control the findings already reported before writing anything new:\n${earlier}\n` : '') +
    `End with exactly one standalone verdict line SLOPIFY_REVIEW={"verdict":"approved"} or SLOPIFY_REVIEW={"verdict":"rejected","reason":"concrete reason"}.`;
}

/** Message de correction : les constats du reviewer partent comme NOUVEAU message à la même session implémenteur, qui corrige, revalide et commite avant la revue suivante. */
function correctionMessage(review: PiReviewOutcome): string {
  return `The independent review rejected the work (cycle ${review.cycle}${review.reason ? `: ${review.reason}` : ''}).\n` +
    `Correct every finding, revalidate, then commit before the next review.\n\n${review.findings}`;
}

/** Brief système de la session reviewer (reviewer.md) : revue en lecture seule, délégation parallèle Standards/Spec, verdict unique obligatoire. */
function reviewerHarness(context: TaskAgentContext): string {
  return `Independent review harness for task ${context.taskId}. This is a read-only session that never shares the implementer conversation: judge only from the durable repository evidence, never from implementer declarations.\n` +
    `Delegated agents are named standards and spec; delegate both axes in one parallel subagent call ({tasks: [{agent, task}, {agent, task}]}), then verify their findings yourself.\n` +
    `End your final assistant message with exactly one standalone verdict line: SLOPIFY_REVIEW={"verdict":"approved"} or SLOPIFY_REVIEW={"verdict":"rejected","reason":"concrete remaining blocker"}. Never put this verdict line in intermediate messages or reviewer reports.`;
}

/** Point d'entrée shellQuote du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Brief d'un sous-agent reviewer délégué (standards ou spec) dans le conteneur. */
function reviewerRole(axis: 'standards' | 'spec', context: TaskAgentContext, officialReview: string): string {
  return `---\nname: ${axis}\ndescription: Independent ${axis} review\ntools: read, grep, find, ls, bash\n---\n` +
    `Perform only the delegated ${axis} review. Read-only inspection; do not edit or commit.\n` +
    `Read the complete frozen spec at ${context.containerContextPath}/spec.md.\n` +
    `Read AGENTS.md and every applicable repository instruction and standards source, including inherited references.\n` +
    `Shared official skill source: ${context.skillsStore}/code-review/SKILL.md; all its referenced resources are available in that readonly store.\n` +
    `Default diff: git diff ${context.taskBaseCommit}...HEAD; commits: git log ${context.taskBaseCommit}..HEAD --oneline.\n` +
    `Read the actual streamed execution traces at ${path.dirname(context.containerContextPath)}/stdout.log and ${path.dirname(context.containerContextPath)}/stderr.log, and observed commands at ${path.dirname(context.containerContextPath)}/commands.jsonl.\n` +
    `The task prompt is ${JSON.stringify(context.prompt)}. Do not mistake an agent declaration for observed process evidence.\n` +
    `Report missing evidence as unverified, rather than inferring TDD or successful commands from commits or a final diff.\n` +
    `For Standards distinguish documented breaches from heuristic smells; repository standards override the baseline. For Spec quote missing, wrong or extra requirements.\n` +
    `The following installed official skill is reference material, including its full fixed smell baseline. Perform only your delegated axis; do not repeat its parent delegation workflow.\n\n${officialReview}\n`;
}
