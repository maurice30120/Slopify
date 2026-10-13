import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, copyFileSync, cpSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, '../../..');
const output = process.argv[2] ? resolve(process.argv[2]) : scriptDirectory;
const fixture = mkdtempSync(join(tmpdir(), 'slopify-vibe-audit-'));
const logs = join(output, 'logs');
mkdirSync(logs, {recursive:true});
const summary = {startedAt:new Date().toISOString(), fixture, commands:[]};
function command(label, args, cwd=root, timeout=60000) {
  const started=Date.now();
  const r=spawnSync('rtk', ['proxy', ...args], {cwd, encoding:'utf8', timeout, maxBuffer:32*1024*1024, stdio:['ignore','pipe','pipe']});
  writeFileSync(join(logs, `${label}.stdout.log`), r.stdout ?? '');
  writeFileSync(join(logs, `${label}.stderr.log`), r.stderr ?? '');
  const entry={label,args,cwd,exitCode:r.status,signal:r.signal,durationMs:Date.now()-started,...(r.error?{error:r.error.message}:{})};
  summary.commands.push(entry);
  writeFileSync(join(output,'summary.json'), JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify(entry));
  return r;
}
command('environment',['node','--version']);
command('sbx-version',['sbx','version']);
const before=command('sandboxes-before',['sbx','ls','--json']);
command('network-policy',['sbx','policy','ls','--json']);
mkdirSync(join(fixture,'.acp','pipelines'),{recursive:true});
mkdirSync(join(fixture,'.acp','agents'),{recursive:true});
copyFileSync(join(root,'.acp','pipelines','simple.yaml'),join(fixture,'.acp','pipelines','simple.yaml'));
copyFileSync(join(root,'.acp','agents','simple-implementer.md'),join(fixture,'.acp','agents','simple-implementer.md'));
cpSync(join(root,'.agents','skills','implement'),join(fixture,'.agents','skills','implement'),{recursive:true});
writeFileSync(join(fixture,'.acp','acp-agents.json'),JSON.stringify({agents:{'Vibe Sandbox':{transport:'sandbox',agent:'vibe',model:'mistral-medium-latest'}},pipeline:{enabled:true,timeouts:{initializeMs:120000,promptMs:180000}}},null,2)+'\n');
writeFileSync(join(fixture,'README.md'),'# Slopify Vibe audit fixture\n');
writeFileSync(join(fixture,'.gitignore'),'.acp/logs/\n.acp/runs-v3/\n');
for (const [label,args] of [
  ['init',['git','init','--initial-branch=main']],
  ['line-endings',['git','config','core.autocrlf','false']],
  ['identity-name',['git','config','user.name','Slopify Audit']],
  ['identity-email',['git','config','user.email','slopify-audit@localhost']],
  ['add',['git','add','.']],
  ['commit',['git','commit','-m','Initialize isolated Vibe audit fixture']],
]) {if(command(label,args,fixture).status!==0) throw new Error(label+' failed');}
summary.baseCommit=command('base-head',['git','rev-parse','HEAD'],fixture).stdout.trim();
command('fixture-list',['node',join(root,'slopify/dist/src/cli.js'),'list','--json','--cwd',fixture]);
const run=command('pipeline',['node',join(root,'slopify/dist/src/cli.js'),'run','simple','Create only audit-marker.txt containing exactly slopify audit ok followed by one newline. Verify its exact contents using the terminal. Do not change any other file. Do not commit or launch other pipelines or agents. Return the verification command and its result.','--agent','Vibe Sandbox','--cwd',fixture,'--json','--verbose'], root, 360000);
summary.pipelineExitCode=run.status;
summary.finalCommit=command('final-head',['git','rev-parse','HEAD'],fixture).stdout.trim();
summary.markerExists=existsSync(join(fixture,'audit-marker.txt'));
summary.markerCorrect=summary.markerExists&&readFileSync(join(fixture,'audit-marker.txt'),'utf8')==='slopify audit ok\n';
const status=command('final-status',['git','status','--porcelain=v1'],fixture);
const files=command('changed-files',['git','diff','--name-only',summary.baseCommit,'HEAD'],fixture);
command('final-diff',['git','diff',summary.baseCommit,'HEAD'],fixture);
const after=command('sandboxes-after',['sbx','ls','--json']);
if(existsSync(join(fixture,'.acp','logs'))) cpSync(join(fixture,'.acp','logs'),join(output,'runtime-logs'),{recursive:true});
if(existsSync(join(fixture,'.acp','runs-v3'))) cpSync(join(fixture,'.acp','runs-v3'),join(output,'runs-v3'),{recursive:true});
cpSync(join(fixture,'.acp','pipelines'),join(output,'fixture-config','pipelines'),{recursive:true});
summary.finishedAt=new Date().toISOString();
const inventory=r=>JSON.parse(r.stdout).sandboxes.map(s=>s.name).sort();
summary.cleanupVerified=before.status===0&&after.status===0&&JSON.stringify(inventory(before))===JSON.stringify(inventory(after));
summary.onlyMarkerChanged=files.status===0&&files.stdout.trim()==='audit-marker.txt';
summary.cleanHost=status.status===0&&status.stdout.trim()==='';
summary.success=run.status===0&&run.stdout.includes('"status": "completed"')&&summary.markerCorrect&&summary.finalCommit!==summary.baseCommit&&summary.onlyMarkerChanged&&summary.cleanHost&&summary.cleanupVerified;
writeFileSync(join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({success:summary.success,fixture,markerCorrect:summary.markerCorrect}));
process.exitCode=summary.success?0:1;
