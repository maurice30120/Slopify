import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { load } from 'js-yaml';
import type { TaskWorkerPoolConfig } from './taskWorkerPool.js';

/** Runtime configuration is frozen by the batch service when a run is created. */
export async function loadTaskRuntimeConfig(repositoryPath:string):Promise<TaskWorkerPoolConfig> {
  let text:string;
  try{text=await readFile(path.join(repositoryPath,'.slopify','runtime.yaml'),'utf8');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {size:10,mounts:[],lifecycle:'reuse'};throw error;}
  const document=load(text);
  if(!document||typeof document!=='object'||Array.isArray(document))throw new Error('Runtime YAML must be an object.');
  const workers=(document as {workers?:unknown}).workers;
  if(!workers||typeof workers!=='object'||Array.isArray(workers))throw new Error('Runtime YAML must define workers.');
  const input=workers as Record<string,unknown>;
  const size=input.size??10,mounts=input.mounts??[],lifecycle=input.lifecycle??'reuse';
  if(typeof size!=='number'||!Number.isInteger(size)||size<1||size>10)throw new Error('workers.size must be an integer from 1 to 10.');
  if(!Array.isArray(mounts)||mounts.some(value=>typeof value!=='string'||!value.endsWith(':ro')||!path.isAbsolute(value.slice(0,-3))))throw new Error('workers.mounts must contain absolute readonly paths ending in :ro.');
  if(lifecycle!=='reuse'&&lifecycle!=='recreate')throw new Error('workers.lifecycle must be reuse or recreate.');
  if(input.image!==undefined&&(typeof input.image!=='string'||!input.image.trim()))throw new Error('workers.image must be a nonempty Docker image reference.');
  return {size,mounts:mounts as string[],lifecycle,...(typeof input.image==='string'?{image:input.image}:{})};
}
