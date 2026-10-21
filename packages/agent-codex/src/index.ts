import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { TaskAgentAdapter, TaskDiagnostic } from '@slopify/execution';
import { agentOutcomeDiagnostics } from '@slopify/execution';

export const codexAdapter:TaskAgentAdapter={
  agent:'codex',
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async prepare(){return {createTarget:'codex'};},
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async run(context){
    const probe=await context.command(['exec',context.sandboxName,'sh','-c',
      'set -eu; for skill in implement tdd code-review; do test -r "$HOME/.agents/skills/$skill/SKILL.md"; done; target=$(readlink -f "$HOME/.agents/skills/implement"); test -n "$target"; options=$(findmnt -n -o OPTIONS -T "$target"); case ",$options," in *,ro,*) ;; *) echo "Official skills are not readonly" >&2; exit 1;; esac; codex --version']);
    if(probe.exitCode!==0)return {exitCode:probe.exitCode,report:probe.stderr,diagnostics:[{code:'codex_capability',message:probe.stderr||'Readonly official skills or Codex unavailable.'}]};
    const harness=await readFile(path.join(context.containerContextPath,'harness.txt'),'utf8');
    const codexArgs=['exec','--dangerously-bypass-approvals-and-sandbox','--json'];
    if(context.model)codexArgs.push('--model',context.model);
    if(context.effort)codexArgs.push('-c',`model_reasoning_effort=${context.effort}`);
    codexArgs.push('-c',`developer_instructions=${JSON.stringify(harness)}`,context.prompt);
    const run=await context.command(['exec','-w',context.containerWorkspacePath,context.sandboxName,'codex',...codexArgs]);
    const diagnostics:TaskDiagnostic[]=[];
    const reports:string[]=[];
    const sessionRoot=await context.command(['exec',context.sandboxName,'sh','-c',`printf '%s' "$HOME/.codex/sessions"`]);
    const sessions=sessionRoot.stdout.trim();
    if(sessionRoot.exitCode===0 && path.isAbsolute(sessions)) {
      const copied=await context.command(['cp',`${context.sandboxName}:${sessions}`,path.join(context.resultDirectory,'codex-sessions')]);
      if(copied.exitCode!==0)diagnostics.push({code:'codex_evidence_unavailable',message:copied.stderr||'Cannot persist native Codex reviewer rollouts.'});
      else diagnostics.push(...await nativeCodexFailures(path.join(context.resultDirectory,'codex-sessions')));
    }else diagnostics.push({code:'codex_evidence_unavailable',message:'Cannot discover native Codex reviewer rollouts.'});
    for(const line of run.stdout.split(/\r?\n/)){
      try {const event=JSON.parse(line);if(event.type==='error'||event.type==='turn.failed')diagnostics.push({code:'codex_error',message:event.message??event.error?.message??line});
        if(event.type==='item.completed'&&event.item?.type==='agent_message')reports.push(event.item.text);
      }catch{/* Non-JSON startup messages remain in the raw log. */}
    }
    diagnostics.push(...agentOutcomeDiagnostics(reports.at(-1) ?? ''));
    return {exitCode:run.exitCode,report:reports.join('\n\n')||run.stdout||run.stderr,diagnostics};
  },
};


/** Point d'entrée object du cycle de vie du pipeline.
 * Garantit un résultat conforme au contrat et signale les entrées ou états qui ne peuvent pas être traités.
 */
function object(value: unknown): Record<string,unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string,unknown> : undefined;
}

async function nativeCodexFailures(directory: string): Promise<TaskDiagnostic[]> {
  const diagnostics: TaskDiagnostic[] = [];
  try {
    for (const file of await readdir(directory,{recursive:true})) {
      if (!file.endsWith('.jsonl')) continue;
      const calls = new Map<string,string>();
      for (const line of (await readFile(path.join(directory,file),'utf8')).split(/\r?\n/)) {
        let event: Record<string,unknown> | undefined;
        try { event=object(JSON.parse(line)); } catch { continue; }
        const payload=object(event?.payload);
        if (!payload) continue;
        if (payload.type==='function_call' && payload.namespace==='collaboration' && typeof payload.call_id==='string' && typeof payload.name==='string') {
          calls.set(payload.call_id,payload.name);
        }
        if (payload.type!=='function_call_output' || typeof payload.call_id!=='string' || typeof payload.output!=='string') continue;
        const tool=calls.get(payload.call_id);
        if (!tool) continue;
        let output: Record<string,unknown> | undefined;
        try {output=object(JSON.parse(payload.output));} catch {continue;}
        if (!output) continue;
        if (output.error) diagnostics.push({code:'codex_subagent_error',message:tool+': '+JSON.stringify(output.error)});
        if (tool==='list_agents' && Array.isArray(output.agents)) {
          for (const entry of output.agents) {
            const agent=object(entry);
            const status=object(agent?.agent_status);
            if (agent?.agent_status==='errored' || agent?.agent_status==='failed' || status?.errored || status?.failed) {
              diagnostics.push({code:'codex_subagent_error',message:String(agent?.agent_name ?? 'Codex reviewer')+': '+JSON.stringify(agent?.agent_status)});
            }
          }
        }
      }
    }
  } catch(error) {
    diagnostics.push({code:'codex_evidence_unavailable',message:'Cannot read persisted reviewer rollouts: '+String(error)});
  }
  return diagnostics;
}
