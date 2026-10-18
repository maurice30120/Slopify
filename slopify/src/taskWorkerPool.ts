import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { SubprocessExecutor, SubprocessRequest, SubprocessResult } from '@acp-client/sandbox';
import type { TaskExecutionRequest, TaskSandboxResource } from './taskExecution.js';

export interface TaskWorkerPoolConfig {
  size: number;
  mounts: string[];
  lifecycle: 'reuse' | 'recreate';
  image?: string;
}
export type TaskWorkerStatus = 'available' | 'assigned' | 'cleaning' | 'verifying' | 'retired' | 'retained';
export interface TaskWorkerState {
  workerId: string;
  sandboxName: string;
  agent: string;
  status: TaskWorkerStatus;
  taskId?: string;
  attemptId?: string;
  replacements: number;
}
interface Worker extends TaskWorkerState { created: boolean; assetsVolume: string; image: string; sharedMounts: string[]; }
export interface WorkerLease { worker: Worker; container: string; contextVolume: string; seed: string; stage: string; request: TaskExecutionRequest; }
const quote=(value:string)=>"'"+value.replaceAll("'", "'\\''")+"'";

/** A worker retains only immutable images/assets. Every task runs in a fresh Docker container. */
export class TaskWorkerPool {
  private runId?: string;
  private sequence=0;
  private readonly generation=randomUUID();
  private readonly workers:Worker[]=[];
  private readonly leases=new Map<string,WorkerLease>();
  private readonly waiters:Array<()=>void>=[];
  constructor(private readonly execute:SubprocessExecutor, readonly config:TaskWorkerPoolConfig,
    private readonly changed?:(workers:TaskWorkerState[])=>void|Promise<void>) {
    if(!Number.isInteger(config.size)||config.size<1||config.size>10)throw new Error('Worker pool size must be an integer from 1 to 10.');
    if(config.mounts.some(mount=>!mount.endsWith(':ro')||!path.isAbsolute(mount.slice(0,-3))))throw new Error('Shared worker mounts must be absolute readonly paths ending in :ro.');
    if(!['reuse','recreate'].includes(config.lifecycle))throw new Error('Worker lifecycle must be reuse or recreate.');
  }
  private async emit(){await this.changed?.(this.workers.map(({workerId,sandboxName,agent,status,taskId,attemptId,replacements})=>({workerId,sandboxName,agent,status,taskId,attemptId,replacements})));}
  async acquire(request:TaskExecutionRequest):Promise<WorkerLease> {
    if(this.runId && this.runId!==request.runId)throw new Error('A worker pool belongs to exactly one batch.');this.runId=request.runId;
    for(;;){
      if(request.signal?.aborted)throw new Error('Task admission interrupted.');
      let worker=this.workers.find(w=>w.status==='available'&&w.agent===request.agent);
      const live=this.workers.filter(w=>!['retired','retained'].includes(w.status));
      if(!worker && live.length<this.config.size){
        const workerId=String(++this.sequence);const digest=createHash('sha256').update(request.runId+'/'+this.generation+'/'+workerId).digest('hex').slice(0,20);
        worker={workerId:this.generation+'/'+workerId,sandboxName:'slopify-worker-'+digest,agent:request.agent,status:'available',sharedMounts:[],replacements:this.workers.filter(w=>['retired','retained'].includes(w.status)).length,created:false,assetsVolume:'slopify-assets-'+digest,image:this.config.image??(request.agent==='pi'?'docker.io/sbx/pi-image:latest':'docker/sandbox-templates:codex-docker')};this.workers.push(worker);
      }
      // A mixed-agent frontier can replace an idle worker of the other agent.
      if(!worker){const idle=live.find(w=>w.status==='available');if(idle){idle.status='retired';await this.control(idle,request,['rm','--force',idle.sandboxName]);continue;}}
      if(worker){worker.status='assigned';worker.taskId=request.taskId;worker.attemptId=request.attemptId;
        const digest=createHash('sha256').update(request.runId+'/'+request.attemptId+'/'+request.resultDirectory).digest('hex').slice(0,24);
        const lease={worker,container:'slopify-task-'+digest,contextVolume:'slopify-context-'+digest,seed:'slopify-seed-'+digest,stage:'/tmp/slopify-'+digest,request};this.leases.set(request.attemptId,lease);await this.emit();return lease;
      }
      await new Promise<void>((resolve,reject)=>{const wake=()=>{request.signal?.removeEventListener('abort',abort);resolve();};const abort=()=>{const i=this.waiters.indexOf(wake);if(i>=0)this.waiters.splice(i,1);reject(new Error('Task admission interrupted.'));};this.waiters.push(wake);request.signal?.addEventListener('abort',abort,{once:true});});
    }
  }
  private async control(worker:Worker,request:TaskExecutionRequest,args:string[]):Promise<SubprocessResult>{
    const result=await this.execute({command:'sbx',args,cwd:request.workspacePath,stdin:'ignore',signal:request.signal});
    if(result.exitCode!==0)throw new Error('Worker control failed: sbx '+args[0]+': '+(result.stderr||result.stdout));return result;
  }
  private outer(lease:WorkerLease,args:string[]){return this.control(lease.worker,lease.request,['exec',lease.worker.sandboxName,...args]);}
  async transport(lease:WorkerLease,request:SubprocessRequest):Promise<SubprocessResult> {
    const a=request.args;
    if(request.command==='git'&&a[0]==='fetch'&&a[2]?.startsWith('sandbox-')){
      await this.outer(lease,['docker','exec','-w',lease.request.workspacePath,lease.container,'git','bundle','create','/tmp/checkpoint.bundle','HEAD']);
      await this.outer(lease,['docker','cp',lease.container+':/tmp/checkpoint.bundle',lease.stage+'/checkpoint.bundle']);
      const transfer=path.join(lease.request.resultDirectory,'worker-checkpoint.bundle');await this.control(lease.worker,lease.request,['cp',lease.worker.sandboxName+':'+lease.stage+'/checkpoint.bundle',transfer]);
      return this.execute({...request,args:[...a.slice(0,2),transfer,...a.slice(3)]});
    }
    if(request.command!=='sbx')return this.execute(request);
    if(a[0]==='create'&&!a.includes('--help')){await this.createTask(lease,a);return {exitCode:0,stdout:'',stderr:''};}
    if(a[0]==='exec'){
      const nameIndex=a.findIndex((value,index)=>index>0&&value.startsWith('slopify-'));
      if(nameIndex<0)throw new Error('Missing task sandbox identity.');
      const options=a.slice(1,nameIndex);const command=a.slice(nameIndex+1);
      return this.execute({...request,args:['exec',lease.worker.sandboxName,'docker','exec',...(options.includes('-w')?options:['-w',lease.request.workspacePath,...options]),lease.container,...command]});
    }
    if(a[0]==='cp'){
      const source=a[1],target=a[2];
      if(source.startsWith('slopify-')){const file=source.slice(source.indexOf(':')+1);const stage=lease.stage+'/copy-out';await this.outer(lease,['docker','cp',lease.container+':'+file,stage]);return this.control(lease.worker,lease.request,['cp',lease.worker.sandboxName+':'+stage,target]);}
      if(target.startsWith('slopify-')){const file=target.slice(target.indexOf(':')+1);const stage=lease.stage+'/copy-in';await this.control(lease.worker,lease.request,['cp',source,lease.worker.sandboxName+':'+stage]);return this.outer(lease,['docker','cp',stage,lease.container+':'+file]);}
    }
    return this.execute(request);
  }
  private async createTask(lease:WorkerLease,args:string[]) {
    const {worker,request}=lease;const target=args[args.indexOf(request.workspacePath)-1];
    if(!worker.created){
      const extra=args.slice(args.indexOf(request.workspacePath)+2);worker.sharedMounts=[...new Set([...this.config.mounts,...extra])];if(worker.sharedMounts.some(mount=>!mount.endsWith(':ro')))throw new Error('Worker shared mounts must be readonly.');await this.control(worker,request,['create','--name',worker.sandboxName,'--skills','readonly',target,...this.config.mounts,...extra]);worker.created=true;
      await this.control(worker,request,['run','-d','--name',worker.sandboxName]);
      await this.outer(lease,['docker','info']);
      // Host networking is needed by the injected credential proxy. Refuse an exposed Docker TCP daemon.
      await this.outer(lease,['sh','-ec','! ss -ltnH | grep -Eq ":(2375|2376)[[:space:]]"']);
      await this.outer(lease,['docker','pull',worker.image]);
      await this.outer(lease,['docker','volume','create',worker.assetsVolume]);
      await this.outer(lease,['docker','create','--name',lease.seed,'--mount','type=volume,source='+worker.assetsVolume+',target=/assets','--entrypoint','sleep',worker.image,'infinity']);
      await this.outer(lease,['sh','-ec','mkdir -p '+quote(lease.stage+'/assets/skills')+' '+quote(lease.stage+'/assets/codex')+'; cp -aL "$HOME/.agents/skills/." '+quote(lease.stage+'/assets/skills/')+'; cp /etc/ssl/certs/ca-certificates.crt '+quote(lease.stage+'/assets/ca.crt')+'; for f in config.toml auth.json; do if test -f "$HOME/.codex/$f"; then cp "$HOME/.codex/$f" '+quote(lease.stage+'/assets/codex/')+'; fi; done']);
      for(const [index,mount] of worker.sharedMounts.entries()){
        await this.outer(lease,['sh','-ec','mkdir -p '+quote(lease.stage+'/assets/shared'+index)+'; cp -aL '+quote(mount.slice(0,-3))+'/. '+quote(lease.stage+'/assets/shared'+index+'/')]);
      }
      await this.outer(lease,['docker','cp',lease.stage+'/assets/.',lease.seed+':/assets']);await this.outer(lease,['docker','rm','-v',lease.seed]);
    }
    await this.outer(lease,['mkdir','-p',lease.stage]);
    const input=path.join(request.resultDirectory,'input.bundle');const bundled=await this.execute({command:'git',args:['bundle','create',input,'HEAD'],cwd:request.workspacePath,stdin:'ignore',signal:request.signal});if(bundled.exitCode!==0)throw new Error('Cannot prepare task input bundle: '+bundled.stderr);
    await this.control(worker,request,['cp',input,worker.sandboxName+':'+lease.stage+'/input.bundle']);
    await this.control(worker,request,['cp',path.join(request.resultDirectory,'context'),worker.sandboxName+':'+lease.stage+'/context']);
    await this.outer(lease,['docker','volume','create',lease.contextVolume]);
    await this.outer(lease,['docker','create','--name',lease.seed,'--mount','type=volume,source='+lease.contextVolume+',target=/context','--entrypoint','sleep',worker.image,'infinity']);
    await this.outer(lease,['docker','cp',lease.stage+'/context/.',lease.seed+':/context']);await this.outer(lease,['docker','rm','-v',lease.seed]);
    const env=['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy','NODE_USE_ENV_PROXY','MCP_GATEWAY_URL','MCP_SENTINEL_TOKEN_NAME','SBX_CRED_OPENAI_MODE'].flatMap(name=>['-e',name]);
    await this.outer(lease,['docker','run','-d','--name',lease.container,'--network','host','--cap-drop','ALL','--security-opt','no-new-privileges','--mount','type=volume,source='+worker.assetsVolume+',target=/slopify-assets,readonly','--mount','type=volume,source='+lease.contextVolume+',target='+path.join(request.resultDirectory,'context')+',readonly',...worker.sharedMounts.flatMap((mount,index)=>['--mount','type=volume,source='+worker.assetsVolume+',target='+mount.slice(0,-3)+',volume-subpath=shared'+index+',readonly']),...env,'-e','NODE_EXTRA_CA_CERTS=/slopify-assets/ca.crt','-e','SSL_CERT_FILE=/slopify-assets/ca.crt','-e','REQUESTS_CA_BUNDLE=/slopify-assets/ca.crt','--entrypoint','sleep',worker.image,'infinity']);
    await this.outer(lease,['docker','cp',lease.stage+'/input.bundle',lease.container+':/tmp/input.bundle']);
    await this.outer(lease,['docker','exec','-u','root',lease.container,'sh','-ec','mkdir -p '+quote(path.dirname(request.workspacePath))+'; chmod 0777 '+quote(path.dirname(request.workspacePath))+'; if test -f /slopify-assets/codex/config.toml; then cp /slopify-assets/codex/config.toml /home/agent/.codex/config.toml; fi; if test -f /slopify-assets/codex/auth.json; then cp /slopify-assets/codex/auth.json /home/agent/.codex/auth.json; fi; mkdir -p /home/agent/.agents; rm -rf /home/agent/.agents/skills; ln -s /slopify-assets/skills /home/agent/.agents/skills']);
    await this.outer(lease,['docker','exec',lease.container,'git','clone','/tmp/input.bundle',request.workspacePath]);
    await this.outer(lease,['docker','exec','-w',request.workspacePath,lease.container,'git','checkout','--detach',request.taskBaseCommit]);
  }
  resource(lease:WorkerLease,resource:TaskSandboxResource):TaskSandboxResource{return {...resource,workerId:lease.worker.workerId,sandboxName:lease.worker.sandboxName,taskContainerName:lease.container,worktreePath:lease.request.workspacePath,inspectCommand:['sbx','exec',lease.worker.sandboxName,'docker','exec','-it','-w',lease.request.workspacePath,lease.container,'sh']};}
  async retain(lease:WorkerLease){lease.worker.status='retained';await this.emit();this.wake();}
  private wake(){for(const wake of this.waiters.splice(0))wake();}
  async cleanup(resource:TaskSandboxResource):Promise<boolean>{
    const lease=[...this.leases.values()].find(l=>l.container===resource.taskContainerName);if(!lease)throw new Error('This executor does not own the pooled resource; its sandbox is preserved for inspection.');
    const {worker}=lease;if(worker.status==='retained')throw new Error('A failed worker is retained for inspection and cannot be cleaned.');
    try{
      worker.status='cleaning';await this.emit();
      await this.outer(lease,['docker','rm','--force','--volumes',lease.container]);await this.outer(lease,['docker','volume','rm',lease.contextVolume]);
      await this.outer(lease,['rm','-rf','--',lease.stage]);worker.status='verifying';await this.emit();
      const inspect=await this.execute({command:'sbx',args:['exec',worker.sandboxName,'docker','container','ls','-aq','--filter','name=^/'+lease.container+'$'],cwd:lease.request.workspacePath,stdin:'ignore'});
      if(inspect.exitCode!==0||inspect.stdout.trim())throw new Error('Task container cleanup could not be verified.');
      await this.outer(lease,['sh','-ec','test ! -e '+quote(lease.stage)]);await this.outer(lease,['docker','info']);
      if(this.config.lifecycle==='recreate'){worker.status='retired';await this.control(worker,lease.request,['rm','--force',worker.sandboxName]);}else worker.status='available';
      delete worker.taskId;delete worker.attemptId;this.leases.delete(lease.request.attemptId);await this.emit();this.wake();return true;
    }catch(error){worker.status='retired';await this.emit();this.wake();throw error;}
  }
}
