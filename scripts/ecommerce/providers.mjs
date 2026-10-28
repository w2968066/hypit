import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import {check,hash,read,save,fileAt,verifyApproval} from './core.mjs';
import {jobId,completeAttempt} from './attempts.mjs';
import {verifyQuality,qualityEnabled} from './quality.mjs';
import {routeFor} from './settings.mjs';
import {mapLimit,executionSettings,timed} from './execution.mjs';

export function apimartEndpoints(base=process.env.APIMART_BASE_URL || 'https://api.apimart.ai') {
  let url;try{url=new URL(base.trim());}catch{throw new Error('Invalid APIMART_BASE_URL');}
  check(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash,'APIMART_BASE_URL must be HTTPS without credentials or query parameters');
  const root=url.origin+url.pathname.replace(/\/+$/,'').replace(/\/v1$/,'');
  return {base:root,upload:root+'/v1/uploads/images',submit:root+'/v1/videos/generations',query:root+'/v1/tasks/',tokenBalance:root+'/v1/balance',accountBalance:root+'/v1/user/balance'};
}

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
        if(response.statusCode<200 || response.statusCode>=300) {const error=new Error(`Provider HTTP ${response.statusCode}; no automatic POST retry`);error.httpStatus=response.statusCode;return reject(error);}
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
    check(receipt.status!=='failed','Task failed; no automatic paid retry');
    check(receipt.task_id,'Previous POST outcome unknown: reconcile manually; never auto-resubmit');
  } else {
    await save(fileAt(root,`requests/${id}.json`),{provider:spec.provider,identity:spec.identity,at:new Date().toISOString()});
    // Prepare uploads first. No billable POST has occurred if preparation fails.
    const submitOptions=await timed(root,'prepare',id,spec.prepare);
    if(spec.beforeSubmit)try{await spec.beforeSubmit();}catch(error){error.noFallback=true;throw error;}
    receipt={digest,status:'submitting',at:new Date().toISOString(),provider:spec.provider,submit_url:spec.submit,query_url:spec.query};
    await save(receiptFile,receipt);
    let response;
    try {response=await transport(spec.submit,{...submitOptions,method:'POST',key:spec.key});}
    catch(error){if(error.httpStatus>=400&&error.httpStatus<500&&error.httpStatus!==408){receipt.status='failed';receipt.reason=error.message;await save(receiptFile,receipt);}throw error;}
    if(response.error){receipt.status='failed';receipt.reason='Provider rejected submission';await save(receiptFile,receipt);throw new Error(receipt.reason);}
    const task=spec.taskId(response);check(typeof task==='string' && /^[a-zA-Z0-9_-]+$/.test(task),'No task ID; submission outcome unknown');
    receipt.task_id=task;receipt.status='submitted';receipt.submitted_at=new Date().toISOString();await save(receiptFile,receipt);
  }
  // Bounded polling is deterministic, not an agent loop. A timeout resumes the same receipt.
  const deadline=Date.now()+1200000;
  while(Date.now()<deadline) {
    const response=await transport((receipt.query_url || spec.query)+encodeURIComponent(receipt.task_id),{key:spec.key,timeout:120000});
    const status=spec.parse(response);receipt.status=status.status;
    if(status.reason)receipt.reason=status.reason;
    await save(receiptFile,receipt);
    if(status.status==='failed')throw new Error('Generation failed: '+status.reason);
    if(status.status==='complete') {
      receipt.completed_at ??= new Date().toISOString();
      const bytes=await timed(root,'download',id,()=>transport(status.url,{binary:true,timeout:120000}));
      check(bytes.length>100,'Empty media output');
      if(spec.provider==='comfly')check(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'Expected PNG; preserve receipt and inspect actual format');
      else check(bytes.subarray(4,8).toString()==='ftyp','Expected MP4');
      const target=fileAt(root,spec.output);await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.writeFile(target+'.partial',bytes);await fs.rename(target+'.partial',target);
      receipt.status='downloaded';receipt.downloaded_at=new Date().toISOString();receipt.output_sha256=hash(bytes);receipt.output=spec.output;await save(receiptFile,receipt);return receipt;
    }
    await new Promise(resolve=>setTimeout(resolve,5000));
  }
  throw new Error('Task pending; resume same command to poll existing task');
}
function mime(file){return file.endsWith('.png')?'image/png':file.endsWith('.webp')?'image/webp':'image/jpeg';}
async function assets(root,refs){return Promise.all(refs.map(async(ref,i)=>({field:'image',name:`ref-${i}${path.extname(ref)}`,mime:mime(ref),bytes:await fs.readFile(fileAt(root,ref))})));}
async function done(root,id,identity,output){const receipt=await optional(fileAt(root,`receipts/${id}.json`));return receipt?.status==='downloaded'&&receipt.digest===hash(JSON.stringify(identity))&&receipt.output_sha256===hash(await fs.readFile(fileAt(root,output)).catch(e=>{if(e.code==='ENOENT')return Buffer.alloc(0);throw e;}));}
async function nativeHandoff(root,type,id,refs,fields,identity,receiptId,error){
  if(error.noFallback)throw error;
  const plan=await read(path.join(root,'plan.json')),route=routeFor(plan,type);
  if(route!=='native' && plan.generation.fallback?.[type]!==true)throw error;
  const receipt=await optional(fileAt(root,`receipts/${receiptId}.json`));
  if(receipt && receipt.status!=='failed'){
    if(!receipt.task_id)throw new Error('API submission outcome unknown; reconcile it before native fallback or another API submission');
    throw error;
  }
  const request={schema:'hypit.ecommerce.native-request.v1',type,id,api_receipt:receiptId,digest:hash(JSON.stringify(identity)),plan_digest:hash(JSON.stringify(await read(path.join(root,'plan.json')))),reference_sha256:identity.refs,prompt:fields.prompt,references:refs.map(x=>path.resolve(root,x)),requested:fields,
    reason:String(error.message).slice(0,300),instruction:`Check the current agent tools for native ${type} generation. Use it if available, preserving references and 9:16. Otherwise report capability unavailable; never claim a generated output. Import the returned local file with native-import. Preserve the API receipt; do not auto-resubmit.`};
  const file=fileAt(root,`native-fallback/${type}-${id}.json`);await save(file,request);
  return {status:'native_fallback_required',route,request:path.resolve(file),...request};
}
export async function generateFrames(root,options={}) {
  const p=await read(path.join(root,'plan.json')),route=routeFor(p,'image');
  const finished=new Set(),execution=executionSettings(p.execution),transport=options.transport || request;
  while(finished.size<p.frames.length){
    const ready=p.frames.filter(f=>!finished.has(f.id)&&(!f.parent||finished.has(f.parent)));
    check(ready.length,'Frame dependency cycle or missing parent');
    const parents=[...new Set(ready.map(f=>f.parent).filter(Boolean))];
    if(parents.length&&await qualityEnabled(root)){
      try{await verifyQuality(root,'frames',parents);}catch{
        if(options.reviewFrames){await options.reviewFrames(parents);await verifyQuality(root,'frames',parents);}
        else return {status:'frame_review_required',ids:parents,next:'Inspect these parent frames and record actual findings before generating their children. No automatic retry.'};
      }
    }
    const results=await mapLimit(ready,route==='native'?1:execution.images,async f=>{
      const operation=async()=>{
    const refs=[...(f.parent?[`frames/${f.parent}.png`]:[]),...p.references];
    const files=await assets(root,refs);
    const roles=p.pipeline_version>=2&&f.parent?'参考图1只提供人物身份与同一场景的物理关系；允许按本镜头改变机位、景别和姿态，不照搬其构图。其余参考图提供用户人物或商品外观。\n':'';
    const fields={model:p.image_model,prompt:roles+f.prompt,aspect_ratio:p.aspect_ratio || '9:16',image_size:p.image_size || '4K',response_format:'url'},identity={fields,refs:files.map(x=>hash(x.bytes))},receiptId=await jobId(root,'image',f.id);
    if(await done(root,receiptId,identity,`frames/${f.id}.png`)){await completeAttempt(root,'image',f.id);return;}
    if(route==='native')return nativeHandoff(root,'image',f.id,refs,fields,identity,receiptId,new Error('User selected native image generation'));
    try {check(process.env.COMFLY_API_KEY,'COMFLY_API_KEY missing');await timed(root,'image',f.id,()=>executeJob(root,receiptId,{provider:'comfly',key:process.env.COMFLY_API_KEY,
      identity,beforeSubmit:()=>options.beforeSubmit?.('image',receiptId),submit:'https://ai.comfly.org/v1/images/edits?async=true',query:'https://ai.comfly.org/v1/images/tasks/',
      prepare:async()=>multipart(fields,files),taskId:r=>r.task_id || r.data?.task_id,parse:parseImage,output:`frames/${f.id}.png`},transport));
    } catch(error){return nativeHandoff(root,'image',f.id,refs,fields,identity,receiptId,error);}
    await completeAttempt(root,'image',f.id);
    console.log(JSON.stringify({frame:f.id,status:'downloaded'}));
      };
      return options.imageLimit?options.imageLimit(operation):operation();
    });
    const handoff=results.find(x=>x?.status==='native_fallback_required');if(handoff)return handoff;
    for(const f of ready)finished.add(f.id);
  }
}
export async function uploadAsset(root,file,endpoints,key,cache,transport=request){
  const identity=hash(endpoints.upload+'\n'+hash(key)+'\n'+hash(file.bytes));
  const prior=cache.get(identity);if(prior&&Date.now()-prior.at<15*60*1000)return prior.promise;
  const promise=timed(root,'upload',hash(file.bytes),async()=>{
    const response=await transport(endpoints.upload,{method:'POST',key,...multipart({},[{...file,field:'file'}])});
    check(typeof response.url==='string'&&response.url.startsWith('https://'),'Unknown upload response');return response.url;
  });
  cache.set(identity,{at:Date.now(),promise});
  try{return await promise;}catch(error){if(cache.get(identity)?.promise===promise)cache.delete(identity);throw error;}
}
export async function generateVideos(root,options={}) {
  const route=routeFor(await read(path.join(root,'plan.json')),'video');
  await verifyApproval(root);await verifyQuality(root,'frames');
  const p=await read(path.join(root,'plan.json'));check(p.tier==='basic','Only basic tier implemented');
  const endpoints=route==='api'?apimartEndpoints():null;
  const cache=options.uploadCache || new Map(),transport=options.transport || request;
  const results=await mapLimit(p.shots,route==='native'?1:executionSettings(p.execution).videos,async s=>{
    const operation=async()=>{
    const anchor=p.scene_anchor || p.frames[0].id;
    const modern=p.pipeline_version>=2;
    const refs=s.frame===anchor?[`frames/${anchor}.png`,...p.references]:modern?[`frames/${s.frame}.png`,`frames/${anchor}.png`,...p.references]:[`frames/${anchor}.png`,`frames/${s.frame}.png`,...p.references],files=await assets(root,refs);
    const visualRoles=modern
      ? '参考图1是本镜头的起始画面，决定机位、景别与起始姿态。'+(s.frame!==anchor?'参考图2仅提供同一场景和人物身份，不覆盖图1的取景。':'')+'其余参考图提供商品或人物外观。'
      : s.frame===anchor
      ? '参考图1锁定角色身份、空间关系与全景构图；后续商品图锁定商品外观。'
      : '参考图1锁定同一组角色、场景和空间关系；参考图2锁定本镜头的商品取景；后续商品图锁定商品实际外观。';
    // Permission is checked above; an unrelated frame's reapproval must not invalidate this shot's media inputs.
    const speech=s.dialogue.trim()?'原生中文对白，逐字说：'+s.dialogue:'本镜头无对白、无口播、无歌唱；只表演画面动作，配乐由后期添加。';
    const timing=modern&&!s.dialogue.trim()?`\n用于成片的是前${s.target_duration}秒：从第0秒开始动作，在这个区间呈现关键动作与结束姿态，余下时间自然延续，不新增动作或镜头。`:'';
    const fields={model:p.video_model,prompt:visualRoles+'\n'+s.prompt+timing+'\n'+speech+'\n不要字幕、水印、背景音乐或新增人物。',duration:s.generation_duration,size:p.aspect_ratio || '9:16',resolution:p.video_resolution || '720p'},identity={fields,refs:files.map(x=>hash(x.bytes))},receiptId=await jobId(root,'video',s.id);
    if(await done(root,receiptId,identity,`clips/${s.id}.mp4`)){await completeAttempt(root,'video',s.id);return;}
    if(route==='native')return nativeHandoff(root,'video',s.id,refs,fields,identity,receiptId,new Error('User selected native video generation'));
    try {check(process.env.APIMART_API_KEY,'APIMART_API_KEY missing');await timed(root,'video',s.id,()=>executeJob(root,receiptId,{provider:'apimart',key:process.env.APIMART_API_KEY,
      identity,beforeSubmit:()=>options.beforeSubmit?.('video',receiptId),
      submit:endpoints.submit,query:endpoints.query,
      prepare:async()=>{
        const urls=[];
        for(const file of files)urls.push(await uploadAsset(root,file,endpoints,process.env.APIMART_API_KEY,cache,transport));
        await verifyApproval(root);
        return {body:Buffer.from(JSON.stringify({...fields,image_urls:urls})),contentType:'application/json'};
      },taskId:r=>r.data?.[0]?.task_id,parse:parseVideo,output:`clips/${s.id}.mp4`},transport));
    }catch(error){return nativeHandoff(root,'video',s.id,refs,fields,identity,receiptId,error);}
    await completeAttempt(root,'video',s.id);
    console.log(JSON.stringify({shot:s.id,status:'downloaded'}));
    };
    return options.videoLimit?options.videoLimit(operation):operation();
  });
  return results.find(x=>x?.status==='native_fallback_required');
}
