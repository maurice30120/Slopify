import { appendFileSync } from 'node:fs';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { createNodeSubprocessExecutor, DockerSandboxRuntime, GitPromotion, type SubprocessExecutor, type SubprocessRequest, type SubprocessResult } from '@acp-client/sandbox';
import type { TaskBatchDiagnostic } from './taskBatch.js';
import type { TaskExecutor, TaskExecutionRequest, TaskExecutionResult, TaskSandboxResource } from './taskExecution.js';
import { createPiTaskAdapter } from './piTaskAdapter.js';

export interface TaskAgentContext extends TaskExecutionRequest {
  sandboxName: string;
  containerWorkspacePath: string;
  containerContextPath: string;
  skillsStore: string;
  command(args: string[]): Promise<SubprocessResult>;
}
export interface TaskAgentAdapter {
  agent: 'codex' | 'pi';
  prepare(context: TaskAgentContext): Promise<{createTarget: string; createMounts?: string[]}>;
  run(context: TaskAgentContext): Promise<{exitCode: number; report: string; diagnostics: TaskBatchDiagnostic[]}>;
}
export interface DockerTaskExecutorOptions { executor?: SubprocessExecutor; adapters?: TaskAgentAdapter[] }

/** Owns only sandbox lifecycle; adapters own agent capabilities, arguments and reports. */
export class DockerTaskExecutor implements TaskExecutor {
  private readonly executor: SubprocessExecutor;
  private readonly adapters: Map<string, TaskAgentAdapter>;
  constructor(options: DockerTaskExecutorOptions = {}) {
    this.executor = options.executor ?? createNodeSubprocessExecutor();
    this.adapters = new Map([codexAdapter, createPiTaskAdapter(), ...(options.adapters ?? [])].map(a => [a.agent,a]));
  }
  async execute(request: TaskExecutionRequest): Promise<TaskExecutionResult> {
    await mkdir(request.resultDirectory,{recursive:true,mode:0o700});
    const stdoutPath=path.join(request.resultDirectory,'stdout.log');
    const stderrPath=path.join(request.resultDirectory,'stderr.log');
    const reportPath=path.join(request.resultDirectory,'report.md');
    const eventsPath=path.join(request.resultDirectory,'commands.jsonl');
    await Promise.all([stdoutPath,stderrPath,eventsPath].map(p=>writeFile(p,'',{mode:0o600})));
    const logged:SubprocessExecutor=async subprocess=>{
      appendFileSync(eventsPath,JSON.stringify({type:'start',command:subprocess.command,args:subprocess.args,time:new Date().toISOString()})+'\n');
      const seen={stdout:false,stderr:false};
      const result=await this.executor({...subprocess,onOutput:(stream,chunk)=>{
        seen[stream]=true;appendFileSync(stream==='stdout'?stdoutPath:stderrPath,chunk);
        subprocess.onOutput?.(stream,chunk);
      }});
      if(!seen.stdout)appendFileSync(stdoutPath,result.stdout);
      if(!seen.stderr)appendFileSync(stderrPath,result.stderr);
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
      const adapter=this.adapters.get(request.agent);
      if(!adapter)throw new Error(`Agent ${request.agent} is unavailable.`);
      const sandboxName='slopify-'+createHash('sha256').update(`${request.runId}/${request.taskId}/${request.attemptId}`).digest('hex').slice(0,24);
      await new DockerSandboxRuntime(logged).preflightWorkspace(request.workspacePath,false,request.signal,[sandboxName]);
      const inventory=JSON.parse((await requireSuccess(['skills','ls','--json'])).stdout) as {store?:string;skills?:string[]};
      if(!inventory.store || !Array.isArray(inventory.skills) || !['implement','tdd','code-review'].every(skill=>inventory.skills!.includes(skill))) {
        throw new Error('Official skills are missing. Install them explicitly with sbx skills add mattpocock/skills.');
      }
      const help=await requireSuccess(['create','--help']);
      if(!help.stdout.includes('--skills'))throw new Error('sbx create must support --skills readonly. Upgrade Docker Sandboxes.');
      const containerContextPath=path.join(request.resultDirectory,'context');
      await mkdir(containerContextPath,{recursive:true});
      await copyFile(request.specFile,path.join(containerContextPath,'spec.md'));
      const harness=[
        'Read the full frozen spec: '+path.join(containerContextPath,'spec.md'),
        'Task baseline: '+request.taskBaseCommit+'; run baseline: '+request.runBaseCommit+'.',
        'Use the official implement skill and its referenced resources. The ticket prompt is unchanged.',
        'TDD interfaces in the ticket are approved. Follow one red/green behavior at a time, targeted validation, full suite, provisional commit before review, independent Standards/Spec review and fixes.',
        'Read all applicable AGENTS.md and repository standards. Review from the task baseline; final review prompts may explicitly use the run baseline.',
        'Actual live raw execution traces: '+stdoutPath+' and '+stderrPath+'. Observed harness commands: '+eventsPath+'. Give these paths to both reviewers.',
        'Treat reports as declarations; missing process/delegation evidence must be reported as missing. End with factual validations, review findings, commits and blockers.',
        'Uncommitted user changes are excluded from this private checkout.',
      ].join('\n');
      await writeFile(path.join(containerContextPath,'harness.txt'),harness,{mode:0o600});
      const context:TaskAgentContext={...request,sandboxName,containerWorkspacePath:request.workspacePath,containerContextPath,skillsStore:inventory.store,command};
      const preparation=await adapter.prepare(context);
      await requireSuccess(['create','--clone','--name',sandboxName,'--skills','readonly',preparation.createTarget,request.workspacePath,`${request.resultDirectory}:ro`,...(preparation.createMounts??[])]);
      resource={sandboxName,inspectCommand:['sbx','exec',sandboxName,'sh'],diagnosticsDirectory:request.resultDirectory};
      await request.onResource?.(resource);
      const head=(await requireSuccess(['exec',sandboxName,'git','rev-parse','HEAD'])).stdout.trim();
      if(head!==request.taskBaseCommit)throw new Error(`Sandbox baseline mismatch: expected ${request.taskBaseCommit}, got ${head}.`);
      const run=await adapter.run(context);
      diagnostics.push(...run.diagnostics);
      await writeFile(reportPath,run.report,{mode:0o600});
      if(run.exitCode!==0 || diagnostics.length) return {exitCode:run.exitCode||1,stdoutPath,stderrPath,reportPath,resource,diagnostics};
      const result=await new GitPromotion(logged).createAgentCheckpoint({workspaceCwd:request.workspacePath,sandboxName,runId:request.runId,nodeId:request.taskId,attempt:1,baseCommit:request.taskBaseCommit,signal:request.signal});
      const ancestry=await logged({command:'git',args:['merge-base','--is-ancestor',request.taskBaseCommit,result.checkpoint.commit],cwd:request.workspacePath,stdin:'ignore'});
      if(ancestry.exitCode!==0)throw new Error('Checkpoint does not descend from the task baseline.');
      const bundlePath=path.join(request.resultDirectory,'checkpoint.bundle');
      const bundled=await logged({command:'git',args:['bundle','create',bundlePath,result.checkpoint.ref],cwd:request.workspacePath,stdin:'ignore'});
      if(bundled.exitCode!==0)throw new Error('Cannot persist the checkpoint bundle: '+bundled.stderr);
      checkpoint={commit:result.checkpoint.commit,bundlePath};
      await writeFile(path.join(request.resultDirectory,'result.json'),JSON.stringify({checkpoint,resource,stdoutPath,stderrPath,reportPath,diagnostics},null,2),{mode:0o600});
      return {exitCode:0,checkpoint,stdoutPath,stderrPath,reportPath,resource,diagnostics};
    } catch(error) {
      const message=error instanceof Error?error.message:String(error);
      diagnostics.push({code:request.signal?.aborted?'interrupted':'execution_failed',message});
      appendFileSync(stderrPath,message+'\n');
      await writeFile(reportPath,'Execution failed: '+message,{mode:0o600});
      return {exitCode:1,checkpoint,stdoutPath,stderrPath,reportPath,resource,diagnostics};
    }
  }
  async cleanup(resource:TaskSandboxResource):Promise<void> {
    const result=await this.executor({command:'sbx',args:['rm',resource.sandboxName],cwd:resource.diagnosticsDirectory??process.cwd(),stdin:'ignore'});
    if(resource.diagnosticsDirectory)appendFileSync(path.join(resource.diagnosticsDirectory,'commands.jsonl'),JSON.stringify({type:'cleanup',args:['rm',resource.sandboxName],exitCode:result.exitCode,stdout:result.stdout,stderr:result.stderr})+'\n');
    if(result.exitCode!==0)throw new Error(result.stderr||'Sandbox cleanup failed.');
  }
}
const codexAdapter:TaskAgentAdapter={
  agent:'codex',
  async prepare(){return {createTarget:'codex'};},
  async run(context){
    const probe=await context.command(['exec',context.sandboxName,'sh','-c',
      'set -eu; for skill in implement tdd code-review; do test -r "$HOME/.agents/skills/$skill/SKILL.md"; done; target=$(readlink -f "$HOME/.agents/skills/implement"); test -n "$target"; options=$(findmnt -n -o OPTIONS -T "$target"); case ",$options," in *,ro,*) ;; *) echo "Official skills are not readonly" >&2; exit 1;; esac; codex --version']);
    if(probe.exitCode!==0)return {exitCode:probe.exitCode,report:probe.stderr,diagnostics:[{code:'codex_capability',message:probe.stderr||'Readonly official skills or Codex unavailable.'}]};
    const harness=await readFile(path.join(context.containerContextPath,'harness.txt'),'utf8');
    const run=await context.command(['exec','-w',context.containerWorkspacePath,context.sandboxName,'codex','exec','--dangerously-bypass-approvals-and-sandbox','--json','-c',`developer_instructions=${JSON.stringify(harness)}`,context.prompt]);
    const diagnostics:TaskBatchDiagnostic[]=[];
    const reports:string[]=[];
    for(const line of run.stdout.split(/\r?\n/)){
      try {const event=JSON.parse(line);if(event.type==='error'||event.type==='turn.failed')diagnostics.push({code:'codex_error',message:event.message??event.error?.message??line});
        if(event.type==='item.completed'&&event.item?.type==='agent_message')reports.push(event.item.text);
      }catch{/* Non-JSON startup messages remain in the raw log. */}
    }
    return {exitCode:run.exitCode,report:reports.join('\n\n')||run.stdout||run.stderr,diagnostics};
  },
};
