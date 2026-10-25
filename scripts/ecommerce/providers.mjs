import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import {check,hash,read,save,fileAt,verifyApproval} from './core.mjs';

export function request(url,{method='GET',key,body,contentType,timeout=600000,binary=false}={}) {
  check(new URL(url).protocol==='https:','HTTPS required');
  return new Promise((resolve,reject)=>{
    const headers={'User-Agent':'Mozilla/5.0 HypitEcommerce/1.0'};
    if(key) headers.Authorization='Bearer '+key;
    if(contentType) headers['Content-Type']=contentType;
    if(body) headers['Content-Length']=body.length;
    const req=https.request(url,{method,headers},response=>{
      const chunks=[];
      response.on('data',chunk=>chunks.push(chunk));response.on('error',()=>reject(new Error('Response read failed')));
      response.on('end',()=>{
        if(response.statusCode<200 || response.statusCode>=300) return reject(new Error(`Provider HTTP ${response.statusCode}; no automatic POST retry`));
        const bytes=Buffer.concat(chunks);
        try {resolve(binary?bytes:JSON.parse(bytes.toString('utf8')));}catch{reject(new Error('Provider returned invalid JSON'));}
      });
    });
    req.setTimeout(timeout,()=>req.destroy(new Error('Request timed out; receipt must be reconciled before any resubmission')));
    req.on('error',err=>reject(new Error(err.code?`Transport ${err.code}`:err.message)));
    if(body) req.write(body);req.end();
  });
}
export function multipart(fields,files) {
  const boundary='hypit-'+crypto.randomUUID(); const chunks=[];
  for(const [name,value] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  for(const f of files) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.name}"\r\nContent-Type: ${f.mime}\r\n\r\n`),f.bytes,Buffer.from('\r\n'));
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {body:Buffer.concat(chunks),contentType:'multipart/form-data; boundary='+boundary};
}
export function parseImage(response) {
  check(!response.error && [undefined,200,'success'].includes(response.code),'Comfly rejected query');
  const d=response.data;check(d && ['NOT_START','SUBMITTED','IN_PROGRESS','SUCCESS','FAILURE'].includes(d.status),'Unknown image task status');
  if(d.status==='FAILURE')return {status:'failed',reason:String(d.fail_reason || 'Image failed').replace(/https?:\/\/\S+|sk-[\w-]+/g,'[redacted]')};
  if(d.status==='SUCCESS') {const url=d.data?.data?.[0]?.url;check(typeof url==='string' && url.startsWith('https://'),'Image success without output');return {status:'complete',url};}
  return {status:'pending'};
}
export function parseVideo(response) {
  check(!response.error && [undefined,200].includes(response.code),'APIMart rejected query');
  const d=response.data;check(d && typeof d==='object','Missing video data');
  if(['failed','cancelled','error'].includes(d.status))return {status:'failed',reason:String(d.error?.message || d.error || 'Video failed').replace(/https?:\/\/\S+|sk-[\w-]+/g,'[redacted]')};
  if(d.status==='completed') {let url=d.result?.videos?.[0]?.url;if(Array.isArray(url))url=url[0];check(typeof url==='string' && url.startsWith('https://'),'Video success without output');return {status:'complete',url};}
  check(['pending','queued','processing','running','submitted','in_progress'].includes(d.status),'Unknown video task status');return {status:'pending'};
}
async function optional(file){try{return await read(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export async function executeJob(root,id,spec,transport=request) {
  const receiptFile=fileAt(root,`receipts/${id}.json`), digest=hash(JSON.stringify(spec.identity));
  let receipt=await optional(receiptFile);
  if(receipt) {
    check(receipt.digest===digest,'Job inputs changed. Create a new reviewed attempt instead of overwriting receipts');
    if(receipt.status==='downloaded') {
      try {if(hash(await fs.readFile(fileAt(root,spec.output)))===receipt.output_sha256)return receipt;} catch(e){if(e.code!=='ENOENT')throw e;}
    }
    check(receipt.task_id,'Previous POST outcome unknown: reconcile manually; never auto-resubmit');
    check(receipt.status!=='failed','Task failed; no automatic paid retry');
  } else {
    // Prepare uploads first. No billable POST has occurred if preparation fails.
    const submitOptions=await spec.prepare();
    receipt={digest,status:'submitting',at:new Date().toISOString(),provider:spec.provider};
    await save(receiptFile,receipt);
    const response=await transport(spec.submit,{...submitOptions,method:'POST',key:spec.key});
    const task=spec.taskId(response);check(typeof task==='string' && /^[a-zA-Z0-9_-]+$/.test(task),'No task ID; submission outcome unknown');
    receipt.task_id=task;receipt.status='submitted';await save(receiptFile,receipt);
  }
  // Bounded polling is deterministic, not an agent loop. A timeout resumes the same receipt.
  const deadline=Date.now()+1200000;
  while(Date.now()<deadline) {
    const response=await transport(spec.query+encodeURIComponent(receipt.task_id),{key:spec.key,timeout:120000});
    const status=spec.parse(response);receipt.status=status.status;
    if(status.reason)receipt.reason=status.reason;
    await save(receiptFile,receipt);
    if(status.status==='failed')throw new Error('Generation failed: '+status.reason);
    if(status.status==='complete') {
      const bytes=await transport(status.url,{binary:true,timeout:120000});
      check(bytes.length>100,'Empty media output');
      if(spec.provider==='comfly')check(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'Expected PNG; preserve receipt and inspect actual format');
      else check(bytes.subarray(4,8).toString()==='ftyp','Expected MP4');
      const target=fileAt(root,spec.output);await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.writeFile(target+'.partial',bytes);await fs.rename(target+'.partial',target);
      receipt.status='downloaded';receipt.output_sha256=hash(bytes);receipt.output=spec.output;await save(receiptFile,receipt);return receipt;
    }
    await new Promise(resolve=>setTimeout(resolve,5000));
  }
  throw new Error('Task pending; resume same command to poll existing task');
}
function mime(file){return file.endsWith('.png')?'image/png':file.endsWith('.webp')?'image/webp':'image/jpeg';}
async function assets(root,refs){return Promise.all(refs.map(async(ref,i)=>({field:'image',name:`ref-${i}${path.extname(ref)}`,mime:mime(ref),bytes:await fs.readFile(fileAt(root,ref))})));}
export async function generateFrames(root) {
  check(process.env.COMFLY_API_KEY,'COMFLY_API_KEY missing');
  const p=await read(path.join(root,'plan.json'));
  for(const f of p.frames) {
    const refs=[...(f.parent?[`frames/${f.parent}.png`]:[]),...p.references];
    const files=await assets(root,refs);
    const fields={model:p.image_model,prompt:f.prompt,aspect_ratio:'9:16',image_size:p.image_size,response_format:'url'};
    await executeJob(root,'image-'+f.id,{provider:'comfly',key:process.env.COMFLY_API_KEY,
      identity:{fields,refs:files.map(x=>hash(x.bytes))},submit:'https://ai.comfly.org/v1/images/edits?async=true',query:'https://ai.comfly.org/v1/images/tasks/',
      prepare:async()=>multipart(fields,files),taskId:r=>r.task_id || r.data?.task_id,parse:parseImage,output:`frames/${f.id}.png`});
    console.log(JSON.stringify({frame:f.id,status:'downloaded'}));
  }
}
export async function generateVideos(root) {
  check(process.env.APIMART_API_KEY,'APIMART_API_KEY missing');await verifyApproval(root);
  const p=await read(path.join(root,'plan.json'));check(p.tier==='basic','Only basic tier implemented');
  for(const s of p.shots) {
    await verifyApproval(root);
    const refs=[`frames/${s.frame}.png`,...p.references],files=await assets(root,refs);
    const fields={model:p.video_model,prompt:s.prompt+'\n原生中文对白，逐字说：'+s.dialogue+'\n不要字幕、水印、音乐或新增人物。',duration:s.generation_duration,size:'9:16',resolution:'720p'};
    await executeJob(root,'video-'+s.id,{provider:'apimart',key:process.env.APIMART_API_KEY,
      identity:{fields,refs:files.map(x=>hash(x.bytes)),approval:await read(path.join(root,'approval.json'))},
      submit:'https://api.apimart.ai/v1/videos/generations',query:'https://api.apimart.ai/v1/tasks/',
      prepare:async()=>{
        const urls=[];
        for(const file of files) {
          const response=await request('https://api.apimart.ai/v1/uploads/images',{method:'POST',key:process.env.APIMART_API_KEY,...multipart({},[{...file,field:'file'}])});
          check(typeof response.url==='string' && response.url.startsWith('https://'),'Unknown upload response');urls.push(response.url);
        }
        await verifyApproval(root);
        return {body:Buffer.from(JSON.stringify({...fields,image_urls:urls})),contentType:'application/json'};
      },taskId:r=>r.data?.[0]?.task_id,parse:parseVideo,output:`clips/${s.id}.mp4`});
    console.log(JSON.stringify({shot:s.id,status:'downloaded'}));
  }
}
