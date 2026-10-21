import { TaskWorkerPool, type TaskWorkerPoolConfig, type TaskWorkerState, type WorkerLease } from './taskWorkerPool.js';
import { appendFileSync } from 'node:fs';
import { mkdir, writeFile, readFile, copyFile, readdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { createNodeSubprocessExecutor, type SubprocessExecutor, type SubprocessRequest, type SubprocessResult, type TaskAgentAdapter, type TaskDiagnostic, type TaskExecutor, type TaskExecutionRequest, type TaskExecutionResource, type TaskExecutionResult } from '@slopify/execution';
import { GitOperations } from '@slopify/git';
import type { TaskAgentContext } from '@slopify/execution';
import { SbxPreflight } from './sbxPreflight.js';
import { codexAdapter } from '@slopify/agent-codex';
import { createPiTaskAdapter } from '@slopify/agent-pi';




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
    this.adapters = new Map([...(options.adapters ?? []), codexAdapter, createPiTaskAdapter()].map(a => [a.agent,a]));
  }
/** Coordonne cette étape du cycle de vie du pipeline, en préservant l'état durable et les erreurs observables. */
  async prepareRun(request: {runId:string;workspacePath:string;signal?:AbortSignal}):Promise<void> {
    if(this.preparation){if(this.preparation.runId!==request.runId)throw new Error('A task executor belongs to one batch.');return this.preparation.promise;}
    const promise=(async()=>{
      await new SbxPreflight(this.executor).preflightWorkspace({cwd:request.workspacePath,signal:request.signal});
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
      const runCommand=lease ? (command:SubprocessRequest)=>this.pool!.rewriteThroughWorker(lease!,command) : this.executor;
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
    const diagnostics:TaskDiagnostic[]=[];
    let resource:TaskExecutionResource|undefined;
    let checkpoint:TaskExecutionResult['checkpoint'];
    try {
      const adapter=this.adapters.get(request.agent);
      if(!adapter)throw new Error(`Agent ${request.agent} is unavailable.`);
      const sandboxName='slopify-'+createHash('sha256').update(`${request.runId}/${request.taskId}/${request.attemptId}`).digest('hex').slice(0,24);
      await this.prepareRun(request);
      lease=await this.pool?.acquire(request);
      const inventory=this.skillsInventory!;
      if(lease)lease.skillsStore=inventory.store;
      const containerContextPath=path.join(request.resultDirectory,'context');
      await mkdir(containerContextPath,{recursive:true});
      await copyFile(request.specFile,path.join(containerContextPath,'spec.md'));
      const harness=[
        'Read the full frozen spec: '+path.join(containerContextPath,'spec.md'),
        'Task baseline: '+request.taskBaseCommit+'; run baseline: '+request.runBaseCommit+'.',
        'The installed skill selected by the native invocation and all its referenced resources are authoritative. The ticket prompt is unchanged.',
        'Test interfaces supplied in the ticket are approved.',
        'Read all applicable AGENTS.md and repository standards before implementation.',
        (lease?'Host-side raw execution traces (outside the task container, preserved by the harness; do not try to read them from inside): ':'Actual live raw execution traces: ')+stdoutPath+' and '+stderrPath+'. Observed harness commands: '+eventsPath+'. Keep them intact as evidence for the final combined review.',
        'Your own native Codex rollout is preserved automatically from $HOME/.codex/sessions; parent and reviewer rollouts live outside this container and the harness collects them itself. Treat reports as declarations: state missing process/delegation evidence as a finding in your final message, not as a task failure; the verdict follows only the required validations and the completeness of the work. End with factual validations, commits and blockers.',
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
      const git = new GitOperations({ executor: logged, gitCommand: (args2, input) => ({
        command: 'sbx', args: ['exec', sandboxName, 'git', ...args2],
        cwd: input.workspaceCwd ?? request.workspacePath, stdin: 'ignore', signal: input.signal,
      }) });
      const result = await git.createAgentCheckpoint({ workspaceCwd: request.workspacePath, sandboxName, runId: request.runId, taskId: request.taskId, attemptId: request.attemptId, baseCommit: request.taskBaseCommit, signal: request.signal });
      // Le checkpoint est committé dans la sandbox ; sa ref est publiée sur le dépôt
      // d'intégration local (remote sandbox-<name>) pour l'ascendance et le bundle.
      const remote = `sandbox-${sandboxName}`;
      await logged({ command: 'git', args: ['fetch', '--no-tags', remote, `+HEAD:${result.checkpoint.ref}`], cwd: request.workspacePath, stdin: 'ignore', signal: request.signal });
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
        if(!resource && lease.worker.created){resource={workerId:lease.worker.workerId,sandboxName:lease.worker.sandboxName,worktreePath:lease.request.workspacePath,inspectCommand:['sbx','exec',lease.worker.sandboxName,'sh'],diagnosticsDirectory:request.resultDirectory};await request.onResource?.(resource);}
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
  async cleanup(resource:TaskExecutionResource):Promise<void> {
    if(resource.workerId && await this.pool?.cleanup(resource)) return;
    const result=await this.executor({command:'sbx',args:['rm','--force',resource.sandboxName],cwd:resource.diagnosticsDirectory??process.cwd(),stdin:'ignore'});
    if(resource.diagnosticsDirectory)appendFileSync(path.join(resource.diagnosticsDirectory,'commands.jsonl'),JSON.stringify({type:'cleanup',args:['rm','--force',resource.sandboxName],exitCode:result.exitCode,stdout:result.stdout,stderr:result.stderr})+'\n');
    if(result.exitCode!==0)throw new Error(result.stderr||'Sandbox cleanup failed.');
  }
}
