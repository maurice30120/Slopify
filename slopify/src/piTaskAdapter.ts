import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { TaskAgentAdapter, TaskAgentContext } from './dockerTaskExecutor.js';
import type { TaskBatchDiagnostic } from './taskBatch.js';

/** Pi's image needs explicit Mistral configuration and the official delegation example. */
export function createPiTaskAdapter(): TaskAgentAdapter {
  return {
    agent: 'pi',
    async prepare(context) {
      const kitPath = path.join(context.resultDirectory, 'pi-kit');
      await mkdir(kitPath, { recursive: true });
      await writeFile(path.join(kitPath, 'spec.yaml'), JSON.stringify({
        schemaVersion: '2', kind: 'sandbox', name: 'slopify-pi-mistral',
        displayName: 'Slopify Pi with Mistral',
        description: 'Pi task execution with proxy-managed Mistral credentials',
        sandbox: { image: 'docker.io/sbx/pi-image:latest', entrypoint: ['pi'] },
        agentInstructions: { filename: 'AGENTS.md' },
        permissions: { network: { allow: ['api.mistral.ai:443'] } },
        credentials: [{ service: 'mistral', apiKey: {
          name: 'MISTRAL_API_KEY', proxyManaged: true,
          inject: [{ domain: 'api.mistral.ai', header: 'Authorization', format: 'Bearer %s' }],
        } }],
        environment: { variables: { PI_OFFLINE: '1', PI_TELEMETRY: '0' } },
      }, null, 2));
      const validation = await context.command(['kit', 'validate', kitPath, '--json']);
      if (validation.exitCode !== 0) throw new Error(`Pi kit validation failed: ${validation.stderr || validation.stdout}`);
      return { createTarget: kitPath, createMounts: [`${context.skillsStore}:ro`] };
    },
    async run(context) {
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
      const configPath = path.join(context.resultDirectory, 'pi-config');
      const containerConfig = '/tmp/slopify-pi-config';
      await mkdir(path.join(configPath, 'agents'), { recursive: true });
      await writeFile(path.join(configPath, 'models.json'), JSON.stringify({ providers: {
        'slopify-mistral': {
          baseUrl: 'https://api.mistral.ai/v1', api: 'openai-completions', apiKey: '${MISTRAL_API_KEY}',
          models: [{ id: 'mistral-medium-latest', name: 'Mistral Medium', reasoning: false,
            input: ['text'], contextWindow: 128000, maxTokens: 8192, compat: { supportsStore: false } }],
        },
      } }, null, 2));
      const officialReview = await readFile(path.join(context.skillsStore, 'code-review', 'SKILL.md'), 'utf8');
      for (const axis of ['standards', 'spec'] as const) {
        await writeFile(path.join(configPath, 'agents', `${axis}.md`), reviewerRole(axis, context, officialReview));
      }
      const harnessPath = path.join(configPath, 'harness.md');
      const sharedHarness = await readFile(path.join(context.containerContextPath, 'harness.txt'), 'utf8');
      const evidenceDirectory = path.dirname(context.containerContextPath);
      await writeFile(harnessPath, [sharedHarness,
        `Harness context for task ${context.taskId}. Preserve the supplied user prompt verbatim.`,
        `Read the complete frozen specification at ${context.containerContextPath}/spec.md.`,
        `Task baseline: ${context.taskBaseCommit}. Run baseline: ${context.runBaseCommit}.`,
        `Official skills and all their resources are mounted readonly at ${context.skillsStore}.`,
        `Follow implement with TDD at the approved public seams; commit before reviewing and correct findings.`,
        `For code-review, invoke the subagent tool once with agentScope user and tasks for agents standards and spec in parallel.`,
        `Give both agents the chosen fixed point (task baseline for implementation, run baseline for final combined review).`,
        `Actual execution stdout and stderr are streamed to ${evidenceDirectory}/stdout.log and ${evidenceDirectory}/stderr.log; commands at ${evidenceDirectory}/commands.jsonl.`,
        `Ask reviewers to read those traces; distinguish observed commands from declarations and flag unavailable evidence.`,
        `Read repository AGENTS.md and every applicable standard before implementation.`,
        `Report final validations and each independent reviewer result honestly.`,
      ].join('\n'));
      const created = await context.command(['exec', context.sandboxName, 'mkdir', '-p', `${containerConfig}/agents`]);
      if (created.exitCode !== 0) throw new Error(`Cannot create Pi configuration directory: ${created.stderr}`);
      for (const relative of ['models.json', 'harness.md', 'agents/standards.md', 'agents/spec.md']) {
        const copied = await context.command(['cp', path.join(configPath, relative), `${context.sandboxName}:${containerConfig}/${relative}`]);
        if (copied.exitCode !== 0) throw new Error(`Cannot provide Pi ${relative}: ${copied.stderr}`);
      }
      const result = await context.command(['exec', '-w', context.containerWorkspacePath,
        '-e', `PI_CODING_AGENT_DIR=${containerConfig}`, context.sandboxName,
        'pi', '--extension', extensionPath, '--offline', '--approve',
        '--provider', 'slopify-mistral', '--model', 'mistral-medium-latest',
        '--skill', context.skillsStore, '--append-system-prompt', `${containerConfig}/harness.md`,
        '--mode', 'json', '--print', context.prompt]);
      const diagnostics: TaskBatchDiagnostic[] = [];
      const reports: string[] = [];
      const reviews: unknown[] = [];
      for (const line of result.stdout.split(/\r?\n/)) {
        let event: Record<string, unknown> | undefined;
        try { event = record(JSON.parse(line)); } catch { continue; }
        if (!event) continue;
        const completedMessages = event.type === 'message_end' ? [event.message]
          : event.type === 'agent_end' && Array.isArray(event.messages) ? event.messages : [];
        for (const value of completedMessages) {
          const text = assistantText(value);
          if (text) reports.push(text);
          const message = record(value);
          if (message?.stopReason === 'error' || message?.stopReason === 'aborted' || message?.errorMessage) {
            const error = String(message.errorMessage || message.stopReason);
            diagnostics.push({ code: 'pi_provider_error', message: error });
            reports.push(`Observed Pi provider error: ${error}`);
          }
        }
        if (event.type !== 'tool_execution_end' || event.toolName !== 'subagent') continue;
        const toolResult = record(event.result);
        const details = record(toolResult?.details);
        const children = Array.isArray(details?.results) ? details.results : [];
        reviews.push({ isError: event.isError, result: event.result });
        if (event.isError === true) diagnostics.push({ code: 'pi_subagent_error', message: 'Pi subagent tool failed.' });
        for (const value of children) {
          const child = record(value);
          if (!child) continue;
          const name = typeof child.agent === 'string' ? child.agent : 'unknown';
          const error = child.errorMessage || child.stderr || child.stopReason || 'unknown child failure';
          if (child.exitCode !== 0 || child.stopReason === 'error' || child.stopReason === 'aborted' || child.errorMessage) {
            diagnostics.push({ code: 'pi_subagent_error', message: `${name}: ${String(error)} (observed exit ${String(child.exitCode)})` });
          }
          const messages = Array.isArray(child.messages) ? child.messages : [];
          const text = messages.map(assistantText).filter(Boolean).join('\n\n');
          reports.push(`## Observed Pi subagent: ${name}\nExit code: ${String(child.exitCode)}\n${text || String(error)}`);
        }
      }
      if (reviews.length) {
        const reviewPath = path.join(context.resultDirectory, 'pi-review-results.json');
        await writeFile(reviewPath, JSON.stringify(reviews, null, 2), { mode: 0o600 });
        reports.push(`Observed delegation results: ${reviewPath}`);
      }
      return { exitCode: result.exitCode, report: reports.join('\n\n') || result.stdout || result.stderr, diagnostics };
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assistantText(value: unknown): string {
  const message = record(value);
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return '';
  return message.content.map(value => {
    const item = record(value);
    return item?.type === 'text' && typeof item.text === 'string' ? item.text : '';
  }).filter(Boolean).join('\n');
}

function reviewerRole(axis: 'standards' | 'spec', context: TaskAgentContext, officialReview: string): string {
  return `---\nname: ${axis}\ndescription: Independent ${axis} review\ntools: read, grep, find, ls, bash\n---\n` +
    `Perform only the delegated ${axis} review. Read-only inspection; do not edit or commit.\n` +
    `Read the complete frozen spec at ${context.containerContextPath}/spec.md.\n` +
    `Read AGENTS.md and every applicable repository instruction and standards source, including inherited references.\n` +
    `Shared official skill source: ${context.skillsStore}/code-review/SKILL.md; all its referenced resources are available in that readonly store.\n` +
    `Default diff: git diff ${context.taskBaseCommit}...HEAD; commits: git log ${context.taskBaseCommit}..HEAD --oneline.\n` +
    `Run baseline is ${context.runBaseCommit}; if the delegated final review selects that baseline, use it instead.\n` +
    `Read the actual streamed execution traces at ${path.dirname(context.containerContextPath)}/stdout.log and ${path.dirname(context.containerContextPath)}/stderr.log, and observed commands at ${path.dirname(context.containerContextPath)}/commands.jsonl.\n` +
    `The task prompt is ${JSON.stringify(context.prompt)}. Do not mistake an agent declaration for observed process evidence.\n` +
    `Report missing evidence as unverified, rather than inferring TDD or successful commands from commits or a final diff.\n` +
    `For Standards distinguish documented breaches from heuristic smells; repository standards override the baseline. For Spec quote missing, wrong or extra requirements.\n` +
    `The following installed official skill is reference material, including its full fixed smell baseline. Perform only your delegated axis; do not repeat its parent delegation workflow.\n\n${officialReview}\n`;
}
