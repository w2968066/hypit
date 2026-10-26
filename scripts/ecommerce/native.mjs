import fs from 'node:fs/promises';
import path from 'node:path';
import {check,read,save,hash,fileAt,media} from './core.mjs';
import {jobId} from './attempts.mjs';
import {probe} from './quality.mjs';

export async function importNative(root,type,id,source,evidence){
  check(['image','video'].includes(type) && evidence?.trim(),'Native type and actual generation evidence required');
  const request=await read(fileAt(root,`native-fallback/${type}-${id}.json`)),p=await read(path.join(root,'plan.json'));
  check(request.plan_digest===hash(JSON.stringify(p)),'Plan changed since native request');
  check(request.api_receipt===await jobId(root,type,id),'Native request was superseded by a newer attempt');
  const original=await read(fileAt(root,`receipts/${request.api_receipt}.json`)).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  check(!original || original.status==='failed','Resolve the API task before importing a native replacement');
  for(let i=0;i<request.references.length;i++)check(hash(await fs.readFile(request.references[i]))===request.reference_sha256[i],'Native references changed');
  const metadata=probe(path.resolve(source)),stream=metadata.streams.find(s=>s.codec_type==='video');
  check(stream && Math.abs(stream.width/stream.height-9/16)<0.015,'Native output must be a real 9:16 image/video');
  if(type==='video'){
    const shot=p.shots.find(s=>s.id===id);
    check(Number(metadata.format.duration)+0.05>=shot.target_duration,'Native clip is too short for the planned dialogue');
    check(metadata.streams.some(s=>s.codec_type==='audio'),'Native dialogue video has no audio');
  }
  const target=fileAt(root,`${type==='image'?'frames':'clips'}/${id}.${type==='image'?'png':'mp4'}`);
  await fs.mkdir(path.dirname(target),{recursive:true});
  const temporary=target+(type==='image'?'.native.png':'.native.mp4');
  if(type==='image')media(['-y','-i',path.resolve(source),'-frames:v','1',temporary]);
  else await fs.copyFile(path.resolve(source),temporary);
  await fs.rename(temporary,target);
  const ledgerFile=path.join(root,'attempts.json'),ledger=await read(ledgerFile).catch(e=>{if(e.code==='ENOENT')return {};throw e;});
  const key=`${type}-${id}`,number=(ledger[key]?.number || 0)+1,receiptId=`${key}-native-${number}`;
  await save(fileAt(root,`receipts/${receiptId}.json`),{status:'downloaded',origin:'native',digest:request.digest,api_receipt:request.api_receipt,
    output:path.relative(root,target).split(path.sep).join('/'),output_sha256:hash(await fs.readFile(target)),requested:request.requested,
    actual:{width:stream.width,height:stream.height,duration:metadata.format.duration || null},evidence,at:new Date().toISOString()});
  ledger[key]={number,receipt:receiptId,pending:false,origin:'native'};await save(ledgerFile,ledger);
  if(type==='image')await fs.unlink(path.join(root,'approval.json')).catch(e=>{if(e.code!=='ENOENT')throw e;});
  return {status:'imported',origin:'native',output:target,actual:{width:stream.width,height:stream.height},requested:request.requested,
    note:'Actual native resolution is recorded; a native output is not claimed to meet API 4K unless its dimensions do.'};
}
