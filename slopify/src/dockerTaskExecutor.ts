import { TaskWorkerPool, type TaskWorkerPoolConfig, type TaskWorkerState, type WorkerLease } from './taskWorkerPool.js';
import { appendFileSync } from 'node:fs';
import { mkdir, writeFile, readFile, copyFile, readdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { createNodeSubprocessExecutor, DockerSandboxRuntime, GitPromotion, type SubprocessExecutor, type SubprocessRequest, type SubprocessResult } from '@acp-client/sandbox';
import type { TaskBatchDiagnostic } from './taskBatch.js';
import type { TaskExecutor, TaskExecutionRequest, TaskExecutionResult, TaskSandboxResource } from './taskExecution.js';
import { createPiTaskAdapter } from './piTaskAdapter.js';
import { agentOutcomeDiagnostics } from './agentOutcome.js';

/** Contrat fonctionnel de TaskAgentContext dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface TaskAgentContext extends TaskExecutionRequest {
  sandboxName: string;
  containerWorkspacePath: string;
  containerContextPath: string;
  skillsStore: string;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  command(args: string[]): Promise<SubprocessResult>;
}
/** Contrat fonctionnel de TaskAgentAdapter dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface TaskAgentAdapter {
  agent: 'codex' | 'pi';
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  prepare(context: TaskAgentContext): Promise<{createTarget: string; createMounts?: string[]}>;
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  run(context: TaskAgentContext): Promise<{exitCode: number; report: string; diagnostics: TaskBatchDiagnostic[]}>;
}
/** Contrat fonctionnel de DockerTaskExecutorOptions dans le cycle de vie du pipeline ; il définit les données et invariants observables. */
export interface DockerTaskExecutorOptions { executor?: SubprocessExecutor; adapters?: TaskAgentAdapter[]; pool?: TaskWorkerPoolConfig; onWorkers?: (workers: TaskWorkerState[]) => void | Promise<void> }

/** Possède uniquement le cycle de vie de la sandbox ; les adaptateurs possèdent les capacités, arguments et rapports de l'agent. */
export class DockerTaskExecutor implements TaskExecutor {
  private readonly executor: SubprocessExecutor;
  private readonly pool?: TaskWorkerPool;
  private preparation?: { runId: string; promise: Promise<void> };
  private skillsInventory?: {store:string;skills:string[]};
  private readonly adapters: Map<string, TaskAgentAdapter>;
/** Initialise ce composant pour le cycle de vie du pipeline concerné. */
  constructor(options: DockerTaskExecutorOptions = {}) {
    this.executor = options.executor ?? createNodeSubprocessExecutor();
    if (options.pool) this.pool = new TaskWorkerPool(this.executor,options.pool,options.onWorkers);
    this.adapters = new Map([codexAdapter, createPiTaskAdapter(), ...(options.adapters ?? [])].map(a => [a.agent,a]));
  }
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async prepareRun(request: {runId:string;workspacePath:string;signal?:AbortSignal}):Promise<void> {
    if(this.preparation){if(this.preparation.runId!==request.runId)throw new Error('A task executor belongs to one batch.');return this.preparation.promise;}
    const promise=(async()=>{
      await new DockerSandboxRuntime(this.executor).preflightWorkspace({cwd:request.workspacePath,workspaceEffects:false,signal:request.signal});
      const command=async(args:string[])=>{const r=await this.executor({command:'sbx',args,cwd:request.workspacePath,stdin:'ignore',signal:request.signal});if(r.exitCode!==0)throw new Error('sbx '+args[0]+' failed: '+(r.stderr||r.stdout));return r;};
      const inventory=JSON.parse((await command(['skills','ls','--json'])).stdout) as {store?:string;skills?:string[]};
      if(!inventory.store||!Array.isArray(inventory.skills)||!['implement','tdd','code-review'].every(skill=>inventory.skills!.includes(skill)))throw new Error('Official skills are missing. Install them explicitly with sbx skills add mattpocock/skills.');
      const help=await command(['create','--help']);if(!help.stdout.includes('--skills'))throw new Error('sbx create must support --skills readonly. Upgrade Docker Sandboxes.');
      this.skillsInventory={store:inventory.store,skills:inventory.skills};
    })();
    this.preparation={runId:request.runId,promise};
    try{await promise;}catch(error){this.preparation=undefined;throw error;}
  }
  async execute(request: TaskExecutionRequest): Promise<TaskExecutionResult> {
    await mkdir(request.resultDirectory,{recursive:true,mode:0o700});
    const stdoutPath=path.join(request.resultDirectory,'stdout.log');
    const stderrPath=path.join(request.resultDirectory,'stderr.log');
    const reportPath=path.join(request.resultDirectory,'report.md');
    const eventsPath=path.join(request.resultDirectory,'commands.jsonl');
    await Promise.all([stdoutPath,stderrPath,eventsPath].map(p=>writeFile(p,'',{mode:0o600})));
    let lease:WorkerLease|undefined;
    const logged:SubprocessExecutor=async subprocess=>{
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
      appendFileSync(eventsPath,JSON.stringify({type:'start',command:subprocess.command,args:subprocess.args,time:new Date().toISOString()})+'\n');
      const seen={stdout:false,stderr:false};
      const runCommand=lease ? (command:SubprocessRequest)=>this.pool!.transport(lease!,command) : this.executor;
      const result=await runCommand({...subprocess,onOutput:(stream,chunk)=>{
        seen[stream]=true;appendFileSync(stream==='stdout'?stdoutPath:stderrPath,chunk);
        subprocess.onOutput?.(stream,chunk);
      }});
      if(!seen.stdout)appendFileSync(stdoutPath,result.stdout);
      if(!seen.stderr)appendFileSync(stderrPath,result.stderr);
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
      appendFileSync(eventsPath,JSON.stringify({type:'end',exitCode:result.exitCode,time:new Date().toISOString()})+'\n');
      return result;
    };
    const command=(args:string[])=>logged({command:'sbx',args,cwd:request.workspacePath,stdin:'ignore',signal:request.signal});
    const requireSuccess=async(args:string[])=>{
      const r=await command(args);if(r.exitCode!==0)throw new Error(`sbx ${args[0]} failed (${r.exitCode}): ${r.stderr || r.stdout}`);return r;
    };
    const diagnostics:TaskBatchDiagnostic[]=[];
    let resource:TaskSandboxResource|undefined;
    let checkpoint:TaskExecutionResult['checkpoint'];
    try {
      lease=await this.pool?.acquire(request);
      const adapter=this.adapters.get(request.agent);
      if(!adapter)throw new Error(`Agent ${request.agent} is unavailable.`);
      const sandboxName='slopify-'+createHash('sha256').update(`${request.runId}/${request.taskId}/${request.attemptId}`).digest('hex').slice(0,24);
      await this.prepareRun(request);
      const inventory=this.skillsInventory!;
      if(lease)lease.skillsStore=inventory.store;
      const containerContextPath=path.join(request.resultDirectory,'context');
      await mkdir(containerContextPath,{recursive:true});
      await copyFile(request.specFile,path.join(containerContextPath,'spec.md'));
      const harness=[
        'Read the full frozen spec: '+path.join(containerContextPath,'spec.md'),
        'Task baseline: '+request.taskBaseCommit+'; run baseline: '+request.runBaseCommit+'.',
        'Use the official implement skill and its referenced resources. The ticket prompt is unchanged.',
        'TDD interfaces in the ticket are approved. Follow one red/green behavior at a time, targeted validation, full suite, then commit. Independent per-ticket Standards/Spec reviews are not required; the batch performs one final combined review of the integration branch.',
        'Read all applicable AGENTS.md and repository standards before implementation.',
        (lease?'Host-side raw execution traces (outside the task container): ':'Actual live raw execution traces: ')+stdoutPath+' and '+stderrPath+'. Observed harness commands: '+eventsPath+'. Keep them intact as evidence for the final combined review.',
        'Codex native parent and reviewer execution rollouts are also in $HOME/.codex/sessions; preserve and inspect them for delegation evidence. Treat reports as declarations; missing process/delegation evidence must be reported as missing. End with factual validations, commits and blockers.',
        'Uncommitted user changes are excluded from this private checkout.',
        'End your final assistant message with exactly one standalone line: SLOPIFY_RESULT={"status":"succeeded"} or SLOPIFY_RESULT={"status":"failed","reason":"concrete remaining blocker"}.',
        'Report failed if final required validations fail or work is incomplete. Expected intermediate TDD red tests are not final failures. A process exit code of zero does not establish task success. Missing or invalid verdicts fail the task. Never put this marker in reviewer reports or intermediate messages.',
      ].join('\n');
      await writeFile(path.join(containerContextPath,'harness.txt'),harness,{mode:0o600});
      const context:TaskAgentContext={...request,sandboxName,containerWorkspacePath:request.workspacePath,containerContextPath,skillsStore:inventory.store,command};
      const preparation=await adapter.prepare(context);
      await requireSuccess(['create','--clone','--name',sandboxName,'--skills','readonly',preparation.createTarget,request.workspacePath,`${request.resultDirectory}:ro`,...(preparation.createMounts??[])]);
      resource={sandboxName,inspectCommand:['sbx','exec',sandboxName,'sh'],diagnosticsDirectory:request.resultDirectory};
      if(lease) resource=this.pool!.resource(lease,resource);
      await request.onResource?.(resource);
      const head=(await requireSuccess(['exec',sandboxName,'git','rev-parse','HEAD'])).stdout.trim();
      if(head!==request.taskBaseCommit)throw new Error(`Sandbox baseline mismatch: expected ${request.taskBaseCommit}, got ${head}.`);
      const run=await adapter.run(context);
      diagnostics.push(...run.diagnostics);
      await writeFile(reportPath,run.report,{mode:0o600});
      if(run.exitCode!==0 || diagnostics.length) {if(lease)await this.pool!.retain(lease); return {exitCode:run.exitCode||1,stdoutPath,stderrPath,reportPath,resource,diagnostics};}
      const result=await new GitPromotion(logged).createAgentCheckpoint({workspaceCwd:request.workspacePath,sandboxName,runId:request.runId,nodeId:request.taskId,attempt:1,baseCommit:request.taskBaseCommit,signal:request.signal});
      const ancestry=await logged({command:'git',args:['merge-base','--is-ancestor',request.taskBaseCommit,result.checkpoint.commit],cwd:request.workspacePath,stdin:'ignore'});
      if(ancestry.exitCode!==0)throw new Error('Checkpoint does not descend from the task baseline.');
      const bundlePath=path.join(request.resultDirectory,'checkpoint.bundle');
      const bundled=await logged({command:'git',args:['bundle','create',bundlePath,result.checkpoint.ref],cwd:request.workspacePath,stdin:'ignore'});
      if(bundled.exitCode!==0)throw new Error('Cannot persist the checkpoint bundle: '+bundled.stderr);
      checkpoint={commit:result.checkpoint.commit,bundlePath};
      const receipt=path.join(request.resultDirectory,'result.json');
      await writeFile(receipt+'.tmp',JSON.stringify({runId:request.runId,taskId:request.taskId,attemptId:request.attemptId,taskBaseCommit:request.taskBaseCommit,completedAt:new Date().toISOString(),exitCode:0,checkpoint,resource,stdoutPath,stderrPath,reportPath,diagnostics},null,2),{mode:0o600});
      await rename(receipt+'.tmp',receipt);
      return {exitCode:0,checkpoint,stdoutPath,stderrPath,reportPath,resource,diagnostics};
    } catch(error) {
      if(lease){
        await this.pool!.retain(lease);
        if(!resource && lease.worker.created){resource=this.pool!.resource(lease,{sandboxName:lease.worker.sandboxName,inspectCommand:['sbx','exec',lease.worker.sandboxName,'sh'],diagnosticsDirectory:request.resultDirectory});await request.onResource?.(resource);}
      }
      const message=error instanceof Error?error.message:String(error);
      diagnostics.push({code:request.signal?.aborted?'interrupted':'execution_failed',message});
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
      appendFileSync(stderrPath,message+'\n');
      await writeFile(reportPath,'Execution failed: '+message,{mode:0o600});
      return {exitCode:1,checkpoint,stdoutPath,stderrPath,reportPath,resource,diagnostics};
    }
  }
/** Termine cette étape du cycle de vie et libère les ressources qui lui appartiennent. */
  async close():Promise<void> {await this.pool?.close();}
  async cleanup(resource:TaskSandboxResource):Promise<void> {
    if(resource.workerId && await this.pool?.cleanup(resource)) return;
    const result=await this.executor({command:'sbx',args:['rm','--force',resource.sandboxName],cwd:resource.diagnosticsDirectory??process.cwd(),stdin:'ignore'});
    if(resource.diagnosticsDirectory)appendFileSync(path.join(resource.diagnosticsDirectory,'commands.jsonl'),JSON.stringify({type:'cleanup',args:['rm','--force',resource.sandboxName],exitCode:result.exitCode,stdout:result.stdout,stderr:result.stderr})+'\n');
    if(result.exitCode!==0)throw new Error(result.stderr||'Sandbox cleanup failed.');
  }
}
const codexAdapter:TaskAgentAdapter={
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
    const diagnostics:TaskBatchDiagnostic[]=[];
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

async function nativeCodexFailures(directory: string): Promise<TaskBatchDiagnostic[]> {
  const diagnostics: TaskBatchDiagnostic[] = [];
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
