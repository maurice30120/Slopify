import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { DockerTaskExecutor } from '../src/dockerTaskExecutor.js';
import type { SubprocessExecutor } from '@acp-client/sandbox';
import type { TaskExecutionRequest } from '../src/taskExecution.js';

function git(cwd: string, ...args: string[]) {return execFileSync('git',args,{cwd,encoding:'utf8'}).trim();}
async function fixture(t: {after(fn:()=>Promise<void>):void}) {
  const root=await mkdtemp(path.join(tmpdir(),'slopify-pool-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=path.join(root,'repo');await mkdir(repo);git(repo,'init','-q');git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.invalid');
  await writeFile(path.join(repo,'base'),'base');git(repo,'add','.');git(repo,'commit','-qm','base');
  const head=git(repo,'rev-parse','HEAD');const spec=path.join(root,'spec.md');await writeFile(spec,'spec');
  const containers=new Map<string,string>();const calls:string[][]=[];const workers:string[]=[];let failHealth=false;let failTask=false;
  const ok=(stdout='')=>({exitCode:0,stdout,stderr:''});
  const execute:SubprocessExecutor=async request=>{
    if(request.command==='git'){const r=spawnSync('git',request.args,{cwd:request.cwd,encoding:'utf8'});return {exitCode:r.status??1,stdout:r.stdout??'',stderr:r.stderr??''};}
    const a=request.args;calls.push(a);
    if(a[0]==='version')return ok('sbx 0.48.0');if(a.includes('--help'))return ok('--clone --skills --json policy init');
    if(a[0]==='policy')return ok('{"initialized":true}');if(a[0]==='skills')return ok(JSON.stringify({store:'/official',skills:['implement','tdd','code-review']}));if(a[0]==='ls')return ok('[]');
    if(a[0]==='create'){workers.push(a[a.indexOf('--name')+1]);return ok();}
    if(a[0]==='rm'||a[0]==='run')return ok();
    if(a[0]==='cp'){const source=a[1].includes(':')?a[1].split(':').slice(1).join(':'):a[1];const target=a[2].includes(':')?a[2].split(':').slice(1).join(':'):a[2];await mkdir(path.dirname(target),{recursive:true});await cp(source,target,{recursive:true,force:true});return ok();}
    if(a[0]==='exec') {
      const d=a.indexOf('docker');if(d<0)return ok();const b=a.slice(d+1);
      if(b[0]==='run'||b[0]==='create'){const name=b[b.indexOf('--name')+1];const cwd=path.join(root,name);await mkdir(cwd,{recursive:true});containers.set(name,cwd);return ok(name);}
      if(b[0]==='rm'){containers.delete(b.at(-1)!);return ok();}
      if(b[0]==='inspect')return {exitCode:1,stdout:'',stderr:'No such container'};
      if(b[0]==='info')return failHealth?{exitCode:1,stdout:'',stderr:'unhealthy'}:ok('{}');
      if(b[0]==='volume'||b[0]==='pull')return ok();
      if(b[0]==='cp') {const s=b[1];const target=b[2];if(target.includes('slopify-seed-'))return ok();if(s.includes(':')){const [name,file]=s.split(':');await mkdir(path.dirname(target),{recursive:true});await cp(path.join(containers.get(name)!,path.basename(file)),target,{recursive:true,force:true});} else if(target.includes(':')){const [name,file]=target.split(':');const cwd=containers.get(name)!;await cp(s,path.join(cwd,path.basename(file)),{recursive:true,force:true});}return ok();}
      if(b[0]==='exec'){
        const name=b.find(v=>containers.has(v))!;const cwd=containers.get(name)!;const g=b.indexOf('git');
        if(g>=0){let args=b.slice(g+1);if(args[0]==='clone'){git(cwd,'clone','-q',path.join(cwd,'input.bundle'),path.join(cwd,'workspace'));return ok();} const dir=path.join(cwd,'workspace');if(args[0]==='bundle'&&args[1]==='create')args=['bundle','create',path.join(cwd,'checkpoint.bundle'),...args.slice(3)];const r=spawnSync('git',args,{cwd:dir,encoding:'utf8'});return {exitCode:r.status??1,stdout:r.stdout??'',stderr:r.stderr??''};}
        if(b.includes('implement-test')){await writeFile(path.join(cwd,'workspace','result'),name);return ok('done');}
        return ok();
      }
      return ok();
    }
    throw new Error('Unhandled '+a.join(' '));
  };
  const executor=new DockerTaskExecutor({executor:execute,pool:{size:1,mounts:[],lifecycle:'reuse'},adapters:[{agent:'codex',async prepare(){return {createTarget:'codex'};},async run(context){const result=await context.command(['exec',context.sandboxName,'implement-test']);return {exitCode:failTask?1:result.exitCode,report:failTask?'task failed':'done',diagnostics:[]};}}]});
  const request=async(id:string):Promise<TaskExecutionRequest>=>{const workspace=path.join(root,id);git(root,'clone','-q',repo,workspace);return {runId:'run',taskId:id,attemptId:id,agent:'codex',workspacePath:workspace,specFile:spec,prompt:id,taskBaseCommit:head,runBaseCommit:head,resultDirectory:path.join(root,'outputs',id)};};
  return {root,repo,head,workers,calls,executor,request,set failHealth(value:boolean){failHealth=value;},set failTask(value:boolean){failTask=value;}};
}

test('successful tasks reuse one worker with distinct worktrees and durable checkpoints',async t=>{
  const f=await fixture(t);const first=await f.executor.execute(await f.request('first'));assert.equal(first.exitCode,0,JSON.stringify(first.diagnostics));await f.executor.cleanup(first.resource!);
  const second=await f.executor.execute(await f.request('second'));assert.equal(second.exitCode,0,JSON.stringify(second.diagnostics));
  assert.equal(f.workers.length,1);assert.equal(first.resource!.sandboxName,second.resource!.sandboxName);assert.notEqual(first.resource!.taskContainerName,second.resource!.taskContainerName);
  assert.notEqual(first.checkpoint!.bundlePath,second.checkpoint!.bundlePath);assert.ok((await readFile(first.checkpoint!.bundlePath)).length>0);assert.equal(git(f.repo,'rev-parse','HEAD'),f.head);
});


test('an unhealthy reset retires the worker while preserving a completed checkpoint',async t=>{
  const f=await fixture(t);const first=await f.executor.execute(await f.request('first'));assert.equal(first.exitCode,0);
  f.failHealth=true;await assert.rejects(f.executor.cleanup(first.resource!),/unhealthy/);f.failHealth=false;
  const second=await f.executor.execute(await f.request('second'));assert.equal(second.exitCode,0,JSON.stringify(second.diagnostics));assert.notEqual(first.resource!.sandboxName,second.resource!.sandboxName);
  assert.equal(f.workers.length,2);assert.ok((await readFile(first.checkpoint!.bundlePath)).length>0);
});

test('a failed task retains its complete worker and an independent task uses a fresh one',async t=>{
  const f=await fixture(t);f.failTask=true;const failed=await f.executor.execute(await f.request('failed'));assert.equal(failed.exitCode,1);assert.ok(failed.resource);assert.equal(failed.checkpoint,undefined);
  const before=await readFile(failed.reportPath!,'utf8');await assert.rejects(f.executor.cleanup(failed.resource!),/retained for inspection/);
  f.failTask=false;const next=await f.executor.execute(await f.request('independent'));assert.equal(next.exitCode,0,JSON.stringify(next.diagnostics));assert.notEqual(next.resource!.sandboxName,failed.resource!.sandboxName);
  assert.equal(await readFile(failed.reportPath!,'utf8'),before);assert.equal(f.calls.some(args=>args[0]==='rm'&&args.includes(failed.resource!.sandboxName)),false);
});

test('one worker remains exclusive until its checkpoint and cleanup finish',async t=>{
  const f=await fixture(t);const first=await f.executor.execute(await f.request('first'));let completed=false;
  const second=f.executor.execute(await f.request('second')).then(result=>{completed=true;return result;});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(completed,false);
  assert.equal(f.calls.filter(args=>args.includes('implement-test')).length,1);await f.executor.cleanup(first.resource!);const result=await second;assert.equal(result.exitCode,0);assert.equal(f.workers.length,1);
});


test('batch shutdown removes available workers and preserves retained failures',async t=>{
  const f=await fixture(t);const succeeded=await f.executor.execute(await f.request('succeeded'));await f.executor.cleanup(succeeded.resource!);
  f.failTask=true;const failed=await f.executor.execute(await f.request('failed'));await f.executor.close();
  assert.equal(f.calls.some(args=>args[0]==='rm'&&args.includes(failed.resource!.sandboxName)),false);
  const g=await fixture(t);const clean=await g.executor.execute(await g.request('clean'));await g.executor.cleanup(clean.resource!);await g.executor.close();
  assert.equal(g.calls.some(args=>args[0]==='rm'&&args.includes(clean.resource!.sandboxName)),true);
});
