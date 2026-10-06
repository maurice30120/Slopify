import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { SubprocessExecutor } from '@acp-client/sandbox';
import { TaskBatchService } from '../src/taskBatch.js';

function git(repo: string, ...args: string[]) { return execFileSync('git', ['-C', repo, ...args], {encoding:'utf8'}).trim(); }
async function fixture(t: {after(fn:()=>Promise<void>):void}, failure = false) {
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
    if(a[0]==='rm'){removed=true;return ok();}
    if(a[0]==='cp')return ok();
    if(a[0]==='exec') {
      const index=a.indexOf('git'); if(index>=0){const r=spawnSync('git',a.slice(index+1),{cwd:sandbox,encoding:'utf8'});return {exitCode:r.status??1,stdout:r.stdout??'',stderr:r.stderr??''};}
      if(a.includes('codex')&&a.includes('exec')){
        assert.equal(a.at(-1),prompt);assert.equal(git(sandbox,'rev-parse','HEAD'),head);
        assert.equal(await readFile(path.join(sandbox,'base.txt'),'utf8'),'committed base');
        await writeFile(path.join(sandbox,'implemented.txt'),'implementation result');
        const stdout=failure?'':JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Tests and review report'}})+'\n';
        return {exitCode:failure?2:0,stdout,stderr:failure?'provider failed':''};
      }
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
