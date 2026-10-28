import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import {check,read,save} from './core.mjs';

const queues=new Map();
// Only protects read/modify/write sections. The CLI's filesystem lock owns the run.
export async function serial(key,operation) {
  const previous=queues.get(key) || Promise.resolve();
  const next=previous.catch(()=>{}).then(operation);queues.set(key,next);
  try{return await next;}finally{if(queues.get(key)===next)queues.delete(key);}
}
export function executionSettings(value={}) {
  const result={jobs:2,images:2,videos:3,...value};
  for(const key of ['jobs','images','videos'])check(Number.isInteger(result[key])&&result[key]>=1&&result[key]<=8,`execution.${key} must be 1–8`);
  return result;
}
export function limiter(width) {
  let active=0;const waiting=[];
  return async operation=>{
    if(active>=width)await new Promise(resolve=>waiting.push(resolve));else active++;
    try{return await operation();}finally{const next=waiting.shift();if(next)next();else active--;}
  };
}
// Drain already-started work before releasing a project lock, even on failure/handoff.
export async function mapLimit(items,width,operation) {
  let index=0,stopped=false,firstError;const results=new Array(items.length);
  await Promise.all(Array.from({length:Math.min(width,items.length)},async()=>{
    while(!stopped&&index<items.length){
      const i=index++;
      try{results[i]=await operation(items[i],i);if(results[i]?.status==='native_fallback_required')stopped=true;}
      catch(error){firstError ??= error;stopped=true;}
    }
  }));
  if(firstError)throw firstError;return results;
}
export async function timed(root,phase,id,operation) {
  const started=Date.now();let status='completed';
  try{return await operation();}catch(error){status='failed';throw error;}
  finally{await save(path.join(root,'timings',crypto.randomUUID()+'.json'),{phase,id,status,started_at:new Date(started).toISOString(),ended_at:new Date().toISOString(),elapsed_ms:Date.now()-started});}
}
export async function diagnostics(root) {
  const names=await fs.readdir(path.join(root,'timings')).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  const events=await Promise.all(names.filter(x=>x.endsWith('.json')).map(x=>read(path.join(root,'timings',x))));
  const phases={};for(const e of events){const p=phases[e.phase] ??= {calls:0,failed:0,total_ms:0};p.calls++;p.failed+=e.status==='failed'?1:0;p.total_ms+=e.elapsed_ms;}
  const attempts=await read(path.join(root,'attempts.json')).catch(e=>{if(e.code==='ENOENT')return {};throw e;});
  const files=await fs.readdir(path.join(root,'receipts')).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  const receipts=await Promise.all(files.filter(x=>x.endsWith('.json')).map(async file=>{const r=await read(path.join(root,'receipts',file));return {id:file.slice(0,-5),status:r.status,provider:r.provider,origin:r.origin,provider_wait_ms:r.completed_at&&r.submitted_at?Date.parse(r.completed_at)-Date.parse(r.submitted_at):null};}));
  return {phases,receipts,wall_span_ms:events.length?Math.max(...events.map(x=>Date.parse(x.ended_at)))-Math.min(...events.map(x=>Date.parse(x.started_at))):null,
    attempts:Object.entries(attempts).map(([id,x])=>({id,number:x.number,pending:x.pending,reason:x.reason,requested_at:x.requested_at})),
    note:'Phases can overlap or nest; totals are not additive wall time. Old runs without timing events cannot be timed retrospectively. No paid retry is automatic.'};
}
