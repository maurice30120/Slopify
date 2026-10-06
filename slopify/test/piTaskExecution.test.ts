import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { SubprocessExecutor } from '@acp-client/sandbox';
import { TaskBatchService } from '../src/taskBatch.js';

function git(repo: string, ...args: string[]) { return execFileSync('git', ['-C', repo, ...args], {encoding:'utf8'}).trim(); }
async function fixture(t: {after(fn:()=>Promise<void>):void}, events?: string, unavailable?: 'extension' | 'readonly') {
  const root = await mkdtemp(path.join(tmpdir(), 'slopify-pi-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const repo = path.join(root,'host');
  execFileSync('git',['init','-q',repo]);
  git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.invalid');
  await writeFile(path.join(repo,'base.txt'),'committed base');git(repo,'add','.');git(repo,'commit','-qm','base');
  const head = git(repo,'rev-parse','HEAD');
  await writeFile(path.join(repo,'base.txt'),'dirty user content');
  const skills = path.join(root,'official skills');await mkdir(path.join(skills, 'code-review'), {recursive:true});
  await writeFile(path.join(skills, 'code-review', 'SKILL.md'), 'Official fixed smell baseline: Mysterious Name, Refused Bequest.');
  await writeFile(path.join(root,'spec.md'),'# Approved full specification');
  const prompt = '$implement\nOriginal approved ticket';
  const batchFile=path.join(root,'batch.json');
  await writeFile(batchFile,JSON.stringify({specFile:'spec.md',tasks:[{id:'work / unsafe',prompt,agent:'pi',source:'01.md',dependsOn:[]}]}));
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
    if(a[0]==='kit')return ok('{}');
    if(a[0]==='ls')return ok('[]');
    if(a[0]==='create') {
      sandbox=path.join(root,'sandbox');execFileSync('git',['clone','-q',request.cwd,sandbox]);
      const name=a[a.indexOf('--name')+1];git(request.cwd,'remote','add',`sandbox-${name}`,sandbox);return ok();
    }
    if(a[0]==='rm'){removed=true;return ok();}
    if(a[0]==='cp') {
      const source=a[1];
      if(source.endsWith('models.json')){const provider=JSON.parse(await readFile(source,'utf8')).providers['slopify-mistral'];assert.equal(provider.models[0].compat.supportsStore,false);assert.equal(provider.apiKey,'${MISTRAL_API_KEY}');}
      if(source.endsWith('standards.md')) {const role=await readFile(source,'utf8');assert.match(role,/AGENTS\.md/);assert.match(role,/Official fixed smell baseline/);assert.match(role,/stdout/);}
      if(source.endsWith('spec.md') && source.includes('agents'))assert.match(await readFile(source,'utf8'), /full.*spec|complete.*spec/i);
      return ok();
    }
    if(a[0]==='exec') {
      const index=a.indexOf('git'); if(index>=0){const r=spawnSync('git',a.slice(index+1),{cwd:sandbox,encoding:'utf8'});return {exitCode:r.status??1,stdout:r.stdout??'',stderr:r.stderr??''};}
      if(a.includes('sh') && a.some(v=>v.includes('findmnt')))return unavailable==='readonly'?{exitCode:1,stdout:'',stderr:'Official skills are writable'}:ok();
      if(a.includes('sh') && a.some(v=>v.includes('npm root -g')))return unavailable==='extension'?{exitCode:1,stdout:'',stderr:'extension missing'}:ok('/opt/pi/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts\n');
      if(a.includes('pi')&&a.includes('--print')){
        assert.equal(a.at(-1),prompt);assert.equal(git(sandbox,'rev-parse','HEAD'),head);
        assert.equal(await readFile(path.join(sandbox,'base.txt'),'utf8'),'committed base');
        await writeFile(path.join(sandbox,'implemented.txt'),'implementation result');
        assert.ok(a.includes('--skill'));assert.ok(a.includes('--extension'));
        const stdout=events ?? JSON.stringify({type:'tool_execution_end',toolName:'subagent',isError:false,result:{details:{mode:'parallel',results:[{agent:'standards',exitCode:0,messages:[{role:'assistant',content:[{type:'text',text:'Independent Standards findings'}]}]},{agent:'spec',exitCode:0,messages:[{role:'assistant',content:[{type:'text',text:'Independent Spec findings'}]}]}]}}})+'\n'+JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Pi tests and review report'}]}})+'\n';
        return {exitCode:0,stdout,stderr:''};
      }
      return ok();
    }
    throw new Error(`Unhandled sbx ${a.join(' ')}`);
  };
  return {root,repo,head,batchFile,prompt,calls,execute,get removed(){return removed;}};
}

test('one Pi task publishes durable checkpoint, logs and report without altering the user workspace',async t=>{
  const f=await fixture(t);
  const service=new TaskBatchService({repositoryPath:f.repo,storePath:path.join(f.root,'runs'),subprocessExecutor:f.execute});
  const state=await service.run(f.batchFile);
  assert.equal(state.status,'succeeded');
  assert.equal(git(f.repo,'show',`${state.integrationBranch}:implemented.txt`),'implementation result');
  assert.equal(git(f.repo,'rev-parse','HEAD'),f.head);
  assert.equal(await readFile(path.join(f.repo,'base.txt'),'utf8'),'dirty user content');
  const attempt=state.tasks[0].attempts[0];
  assert.ok(attempt.checkpoint?.bundlePath);
  assert.match(await readFile(attempt.stdoutPath!,'utf8'),/Pi tests and review report/);
  const report=await readFile(attempt.reportPath!,'utf8');
  assert.match(report,/Pi tests and review report/);
  assert.match(report,/Independent Standards findings/);
  assert.match(report,/Independent Spec findings/);
  const reviewPath=report.match(/Observed delegation results: (.+)/)![1];
  const observed=JSON.parse(await readFile(reviewPath,'utf8'));
  assert.equal(observed[0].result.details.mode,'parallel');
  assert.deepEqual(observed[0].result.details.results.map((r:{agent:string;exitCode:number})=>[r.agent,r.exitCode]),[['standards',0],['spec',0]]);
  assert.equal(f.removed,true);
  const create=f.calls.find(a=>a[0]==='create' && !a.includes('--help'))!;
  assert.ok(create.includes('readonly'));
  assert.ok(create.some(arg=>arg.endsWith('official skills:ro')));
  const kitArg=create.find(arg=>arg.endsWith('pi-kit'))!;
  const kit=JSON.parse(await readFile(path.join(kitArg,'spec.yaml'),'utf8'));
  assert.equal(kit.sandbox.image,'docker.io/sbx/pi-image:latest');
  assert.equal(kit.credentials[0].service,'mistral');
  assert.equal(kit.credentials[0].apiKey.proxyManaged,true);
  assert.equal(kit.permissions,undefined, 'inherits configured global network policy');
});


test('a failed Pi reviewer is visible and retains the sandbox even when the parent exits zero', async t=>{
  const events=JSON.stringify({type:'tool_execution_end',toolName:'subagent',isError:false,result:{details:{mode:'parallel',results:[
    {agent:'standards',exitCode:1,stderr:'Mistral review request rejected',messages:[]},
    {agent:'spec',exitCode:0,messages:[{role:'assistant',content:[{type:'text',text:'Spec report independently observed'}]}]},
  ]}}})+'\n'+JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Parent claims success'}]}})+'\n';
  const f=await fixture(t,events);
  const state=await new TaskBatchService({repositoryPath:f.repo,storePath:path.join(f.root,'runs'),subprocessExecutor:f.execute}).run(f.batchFile);
  assert.equal(state.status,'failed');
  assert.equal(f.removed,false);
  const attempt=state.tasks[0].attempts[0];
  assert.ok(attempt.resource?.sandboxName);
  assert.ok(attempt.diagnostics?.some(d=>d.code==='pi_subagent_error' && /standards.*Mistral review request rejected/s.test(d.message)));
  assert.match(await readFile(attempt.reportPath!,'utf8'),/Spec report independently observed/);
});


test('a Pi provider error encoded in JSONL fails a parent process that returned zero', async t=>{
  const f=await fixture(t,JSON.stringify({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'HTTP 422: provider refused store'}})+'\n');
  const state=await new TaskBatchService({repositoryPath:f.repo,storePath:path.join(f.root,'runs'),subprocessExecutor:f.execute}).run(f.batchFile);
  assert.equal(state.status,'failed');
  const attempt=state.tasks[0].attempts[0];
  assert.ok(attempt.diagnostics?.some(d=>d.code==='pi_provider_error' && d.message.includes('HTTP 422')));
  assert.equal(f.removed,false);
});


test('Pi refuses a writable shared skill mount before starting the model', async t=>{
  const f=await fixture(t,undefined,'readonly');
  const state=await new TaskBatchService({repositoryPath:f.repo,storePath:path.join(f.root,'runs'),subprocessExecutor:f.execute}).run(f.batchFile);
  assert.equal(state.status,'failed');
  assert.ok(state.tasks[0].attempts[0].diagnostics?.some(d=>d.code==='pi_capability' && /writable/.test(d.message)));
  assert.equal(f.calls.some(a=>a.includes('pi') && a.includes('--print')),false);
  assert.equal(f.removed,false);
});


test('missing official Pi delegation capability fails before any model request',async t=>{
  const f=await fixture(t,undefined,'extension');
  const state=await new TaskBatchService({repositoryPath:f.repo,storePath:path.join(f.root,'runs'),subprocessExecutor:f.execute}).run(f.batchFile);
  assert.equal(state.status,'failed');
  assert.ok(state.tasks[0].attempts[0].diagnostics?.some(d=>d.code==='pi_subagent_unavailable'));
  assert.equal(f.calls.some(a=>a.includes('pi') && a.includes('--print')),false);
  assert.equal(f.removed,false);
});

test('Pi terminal agent summary cannot hide a provider error in its messages',async t=>{
  const f=await fixture(t,JSON.stringify({type:'agent_end',messages:[{role:'assistant',content:[],stopReason:'error',errorMessage:'Mistral service unavailable'}]})+'\n');
  const state=await new TaskBatchService({repositoryPath:f.repo,storePath:path.join(f.root,'runs'),subprocessExecutor:f.execute}).run(f.batchFile);
  assert.equal(state.status,'failed');
  assert.ok(state.tasks[0].attempts[0].diagnostics?.some(d=>d.code==='pi_provider_error' && /Mistral service unavailable/.test(d.message)));
});
