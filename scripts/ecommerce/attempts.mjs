import fs from 'node:fs/promises';
import path from 'node:path';
import {check,read,save,fileAt} from './core.mjs';

async function optional(file){return read(file).catch(e=>{if(e.code==='ENOENT')return {};throw e;});}
export async function jobId(root,type,id){return (await optional(path.join(root,'attempts.json')))[`${type}-${id}`]?.receipt || `${type}-${id}`;}
export async function completeAttempt(root,type,id){
  const file=path.join(root,'attempts.json'), state=await optional(file), item=state[`${type}-${id}`];
  if(item){item.pending=false;item.completed_at=new Date().toISOString();await save(file,state);}
}
export async function assertNoPending(root,type){
  const state=await optional(path.join(root,'attempts.json'));
  check(!Object.entries(state).some(([key,value])=>key.startsWith(type+'-')&&value.pending),`Pending ${type} replacement; finish it before approval or assembly`);
}
export async function prepareRetry(root,type,id,reason){
  check(['image','video'].includes(type),'Retry type must be image or video');check(reason?.trim(),'Retry reason required');
  const p=await read(path.join(root,'plan.json')), frames=new Set();
  check((type==='image'?p.frames:p.shots).some(x=>x.id===id),'Unknown retry item');
  if(type==='image'){
    frames.add(id);
    for(const f of p.frames)if(frames.has(f.parent))frames.add(f.id);
  }
  const affected=type==='image' ? [...[...frames].map(x=>['image',x]),...p.shots.filter(s=>frames.has(p.scene_anchor || p.frames[0].id)||frames.has(s.frame)).map(s=>['video',s.id])] : [['video',id]];
  const file=path.join(root,'attempts.json'),state=await optional(file), prepared=[];
  // Reject uncertain or still-running tasks before changing any state.
  for(const [kind,key] of affected){
    const current=state[`${kind}-${key}`]?.receipt || `${kind}-${key}`;
    const receipt=await optional(fileAt(root,`receipts/${current}.json`));
    check(!receipt.status || ['downloaded','failed','native-imported'].includes(receipt.status),'Resume or reconcile the previous task before creating a paid retry');
  }
  for(const [kind,key] of affected){
    const name=`${kind}-${key}`,number=(state[name]?.number || 0)+1,receipt=`${name}-attempt-${number}`;
    const asset=`${kind==='image'?'frames':'clips'}/${key}.${kind==='image'?'png':'mp4'}`;
    const archive=fileAt(root,`attempts/${receipt}/previous.${kind==='image'?'png':'mp4'}`);
    await fs.mkdir(path.dirname(archive),{recursive:true});
    await fs.copyFile(fileAt(root,asset),archive).catch(e=>{if(e.code!=='ENOENT')throw e;});
    state[name]={number,receipt,pending:true,reason:reason.trim(),requested_at:new Date().toISOString()};prepared.push(name);
  }
  await save(file,state);
  if(type==='image')await fs.unlink(path.join(root,'approval.json')).catch(e=>{if(e.code!=='ENOENT')throw e;});
  for(const stage of type==='image'?['frames','videos']:['videos'])
    await fs.unlink(path.join(root,'quality',stage+'-review.json')).catch(e=>{if(e.code!=='ENOENT')throw e;});
  return {status:'prepared',affected:prepared,next:type==='image'?'Run frames --submit, inspect if enabled, then approve the replacement frames.':'Run videos --submit; successful unrelated clips will be reused.'};
}
