import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createNodeSubprocessExecutor, type SubprocessExecutor } from '@acp-client/sandbox';
import { TaskBatchService } from '../src/taskBatch.js';

function git(repo: string, ...args: string[]) { return execFileSync('git', ['-C', repo, ...args], {encoding:'utf8'}).trim(); }
async function fixture(t: {after(fn:()=>Promise<void>):void}, failure: boolean | 'parent-zero-error' | 'cleanup' | 'child-error' = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-docker-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const repo = path.join(root,'host');
  execFileSync('git',['init','-q',repo]);
  git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.invalid');
  await writeFile(path.join(repo,'base.txt'),'committed base');git(repo,'add','.');git(repo,'commit','-qm','base');
  const head = git(repo,'rev-parse','HEAD');
  await writeFile(path.join(repo,'base.txt'),'dirty user content');
  const skills = path.join(root,'official skills');await mkdir(skills);
  await writeFile(path.join(root,'spec.md'),'# Approved full specification');
  const prompt = '$implement\nOriginal approved ticket';
  const batchFile=path.join(root,'batch.json');
  await writeFile(batchFile,JSON.stringify({specFile:'spec.md',tasks:[{id:'work / unsafe',prompt,agent:'codex',source:'01.md',dependsOn:[]}]}));
  const calls: string[][]=[]; let sandbox=''; let removed=false;
  const execute:SubprocessExecutor=async request=>{
    if(request.command==='git') {const r=spawnSync('git',request.args,{cwd:request.cwd,encoding:'utf8'});return {exitCode:r.status??1,stdout:r.stdout??'',stderr:r.stderr??''};}
    calls.push(request.args);
    const a=request.args;
    const ok=(stdout='')=>({exitCode:0,stdout,stderr:''});
    if(a[0]==='version')return ok('sbx 0.47.0');
    if(a.includes('--help'))return ok('--clone --skills --json policy init');
    if(a[0]==='policy')return ok('{"initialized":true}');
    if(a[0]==='skills')return ok(JSON.stringify({store:skills,skills:['implement','tdd','code-review']}));
    if(a[0]==='ls')return ok('[]');
    if(a[0]==='create') {
      sandbox=path.join(root,'sandbox');execFileSync('git',['clone','-q',request.cwd,sandbox]);
      const name=a[a.indexOf('--name')+1];git(request.cwd,'remote','add',`sandbox-${name}`,sandbox);return ok();
    }
    if(a[0]==='rm'){
      const mounted=calls.find(a=>a[0]==='create'&&!a.includes('--help'))!.find(a=>a.startsWith(path.join(root,'runs'))&&a.endsWith(':ro'))!.slice(0,-3);
      assert.match(await readFile(path.join(mounted,'stdout.log'),'utf8'),/Tests and review report/);
      assert.match(await readFile(path.join(mounted,'report.md'),'utf8'),/Tests and review report/);
      assert.ok((await readFile(path.join(mounted,'checkpoint.bundle'))).length>0);
      assert.match(await readFile(path.join(mounted,'codex-sessions','reviewer.jsonl'),'utf8'),/spawn_agent/);
      const state=JSON.parse(await readFile(path.join(mounted,'..','..','state.json'),'utf8'));
      assert.equal(state.tasks[0].status,'succeeded');
      if(!a.includes('--force'))return {exitCode:1,stdout:'',stderr:'rm requires confirmation'};
      if(failure==='cleanup')return {exitCode:1,stdout:'',stderr:'cleanup unavailable'};
      removed=true;return ok();
    }
    if(a[0]==='cp'){if(a.at(-1)?.endsWith('codex-sessions')){await mkdir(a.at(-1)!);await writeFile(path.join(a.at(-1)!,'reviewer.jsonl'),failure==='child-error'?[JSON.stringify({type:'response_item',payload:{type:'function_call',name:'list_agents',namespace:'collaboration',call_id:'review-status'}}),JSON.stringify({type:'response_item',payload:{type:'function_call_output',call_id:'review-status',output:JSON.stringify({agents:[{agent_name:'/root/spec',agent_status:{errored:'review provider failed'}}]})}})].join('\n'):'{"type":"response_item","name":"spawn_agent"}');}return ok();}
    if(a[0]==='exec') {
      const index=a.indexOf('git'); if(index>=0){const r=spawnSync('git',a.slice(index+1),{cwd:sandbox,encoding:'utf8'});return {exitCode:r.status??1,stdout:r.stdout??'',stderr:r.stderr??''};}
      if(a.includes('codex')&&a.includes('exec')){
        assert.equal(a.at(-1),prompt);assert.equal(git(sandbox,'rev-parse','HEAD'),head);
        assert.equal(await readFile(path.join(sandbox,'base.txt'),'utf8'),'committed base');
        await writeFile(path.join(sandbox,'implemented.txt'),'implementation result');
        const stdout=failure===true?'':failure==='parent-zero-error'?JSON.stringify({type:'turn.failed',error:{message:'Provider rejected request'}})+'\n':JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Tests and review report'}})+'\n';
        request.onOutput?.('stdout',stdout);
        const mounted=calls.find(a=>a[0]==='create'&&!a.includes('--help'))!.find(a=>a.startsWith(path.join(root,'runs'))&&a.endsWith(':ro'))!.slice(0,-3);
        assert.ok((await readFile(path.join(mounted,'stdout.log'),'utf8')).includes(stdout));
        const durable=JSON.parse(await readFile(path.join(mounted,'..','..','state.json'),'utf8'));
        assert.equal(durable.tasks[0].attempts[0].resourceState,'active');
        assert.ok(durable.tasks[0].attempts[0].resource.sandboxName);
        return {exitCode:failure===true?2:0,stdout,stderr:failure===true?'provider failed':''};
      }
      if(a.includes('sh')&&a.at(-1)?.startsWith('printf'))return ok('/home/agent/.codex/sessions');
      return ok();
    }
    throw new Error(`Unhandled sbx ${a.join(' ')}`);
  };
  return {root,repo,head,batchFile,prompt,calls,execute,get removed(){return removed;}};
}

test('one Codex task publishes durable checkpoint, logs and report without altering the user workspace',async t=>{
  const f=await fixture(t);
  const service=new TaskBatchService({repositoryPath:f.repo,storePath:path.join(f.root,'runs'),subprocessExecutor:f.execute});
  const state=await service.run(f.batchFile);
  assert.equal(state.status,'succeeded');
  assert.equal(git(f.repo,'show',`${state.integrationBranch}:implemented.txt`),'implementation result');
  assert.equal(git(f.repo,'rev-parse','HEAD'),f.head);
  assert.equal(await readFile(path.join(f.repo,'base.txt'),'utf8'),'dirty user content');
  const attempt=state.tasks[0].attempts[0];
  assert.ok(attempt.checkpoint?.bundlePath);
  assert.match(await readFile(attempt.stdoutPath!,'utf8'),/Tests and review report/);
  assert.match(await readFile(attempt.reportPath!,'utf8'),/Tests and review report/);
  assert.equal(f.removed,true);
  assert.ok(f.calls.find(a=>a[0]==='create'&&!a.includes('--help'))?.includes('readonly'));
});


test('a failed Codex task retains its sandbox and readable diagnostics without integrating changes',async t=>{
  const f=await fixture(t,true);
  const service=new TaskBatchService({repositoryPath:f.repo,storePath:path.join(f.root,'runs'),subprocessExecutor:f.execute});
  const state=await service.run(f.batchFile);
  assert.equal(state.status,'failed');
  assert.equal(state.tasks[0].attempts[0].resourceState,'retained');
  assert.match(await readFile(state.tasks[0].attempts[0].stderrPath!,'utf8'),/provider failed/);
  assert.equal(git(f.repo,'rev-parse',state.integrationBranch),f.head);
  assert.equal(f.removed,false);
  assert.equal((await service.status(state.runId)).tasks[0].status,'failed');
});

test('provider errors are visible even when the Codex parent exits zero',async t=>{
  const f=await fixture(t,'parent-zero-error');
  const state=await new TaskBatchService({repositoryPath:f.repo,storePath:path.join(f.root,'runs'),subprocessExecutor:f.execute}).run(f.batchFile);
  assert.equal(state.status,'failed');
  assert.match(state.tasks[0].attempts[0].diagnostics![0].message,/Provider rejected request/);
  assert.equal(f.removed,false);
});

test('a cleanup failure is recorded without losing a successful published result',async t=>{
  const f=await fixture(t,'cleanup');
  const state=await new TaskBatchService({repositoryPath:f.repo,storePath:path.join(f.root,'runs'),subprocessExecutor:f.execute}).run(f.batchFile);
  assert.equal(state.status,'succeeded');
  assert.equal(state.tasks[0].attempts[0].resourceState,'retained');
  assert.ok(state.tasks[0].attempts[0].diagnostics!.some(d=>d.code==='cleanup_failed'));
  assert.equal(git(f.repo,'show',`${state.integrationBranch}:implemented.txt`),'implementation result');
});

test('native external subprocess output arrives before completion and preserves its complete result',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'slopify-stream-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  let received!:()=>void;
  const firstChunk=new Promise<void>(resolve=>{received=resolve;});
  let finished=false;
  const result=createNodeSubprocessExecutor()({command:process.execPath,args:['-e','process.stdout.write("live trace");setTimeout(()=>process.stderr.write("stderr trace"),40);setTimeout(()=>process.exit(0),80)'],cwd:root,stdin:'ignore',onOutput:(stream,chunk)=>{assert.equal(finished,false);if(stream==='stdout'){assert.equal(chunk,'live trace');received();}}}).then(r=>{finished=true;return r;});
  await firstChunk;
  assert.equal(finished,false);
  assert.deepEqual(await result,{exitCode:0,stdout:'live trace',stderr:'stderr trace'});
});


test('missing official skills stop before a sandbox is created and explain explicit installation',async t=>{
  const f=await fixture(t);
  const external:SubprocessExecutor=request=>request.command==='sbx'&&request.args[0]==='skills'?Promise.resolve({exitCode:0,stdout:JSON.stringify({store:'/official',skills:[]}),stderr:''}):f.execute(request);
  const state=await new TaskBatchService({repositoryPath:f.repo,storePath:path.join(f.root,'runs'),subprocessExecutor:external}).run(f.batchFile);
  assert.equal(state.status,'failed');
  assert.match(state.tasks[0].attempts[0].diagnostics![0].message,/sbx skills add mattpocock\/skills/);
  assert.equal(state.tasks[0].attempts[0].resource,undefined);
  assert.equal(f.calls.some(a=>a[0]==='create'&&!a.includes('--help')),false);
  assert.equal(f.removed,false);
});


test('a native Codex reviewer failure in persisted rollouts fails the task despite parent success',async t=>{
  const f=await fixture(t,'child-error');
  const state=await new TaskBatchService({repositoryPath:f.repo,storePath:path.join(f.root,'runs'),subprocessExecutor:f.execute}).run(f.batchFile);
  assert.equal(state.status,'failed');
  assert.ok(state.tasks[0].attempts[0].diagnostics!.some(d=>d.code==='codex_subagent_error'&&d.message.includes('review provider failed')));
  assert.equal(f.removed,false);
});
