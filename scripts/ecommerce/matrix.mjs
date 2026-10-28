// A finite product × template × repeat workflow. No runtime planning or agent loop.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {check,read,save,hash,fileAt,createPlan,validateTemplate,withLock,approve} from './core.mjs';
import {generationChoice,loadSettings,grillReminder} from './settings.mjs';
import {generateFrames,generateVideos,apimartEndpoints} from './providers.mjs';
import {importNative} from './native.mjs';
import {inspect,recordQuality,verifyQuality,probe} from './quality.mjs';
import {alignCaptions} from './finishing.mjs';
import {assemble} from './assembly.mjs';
import {executionSettings,limiter,mapLimit,serial,timed,diagnostics} from './execution.mjs';

const optional=async file=>read(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
const exists=async file=>(await fs.stat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;}))?.isFile();
const checksum=async file=>hash(await fs.readFile(file));
const musicExtensions=new Set(['.mp3','.wav','.m4a','.aac','.flac','.ogg','.opus']);
const digestOf=value=>hash(JSON.stringify(value));
function folderName(name) {
  check(typeof name==='string' && name.trim()===name && name && name!=='.' && name!=='..' && !/[<>:"/\\|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name),'Unsafe product output folder name');
  return name;
}
function hookSpec(value,cwd) {
  if(!value)return null;
  check(typeof value.command==='string' && value.command && Array.isArray(value.args) && value.args.every(x=>typeof x==='string'),'Hook requires command and args array; no shell command string');
  const timeout=value.timeout_ms ?? 600000;check(Number.isInteger(timeout)&&timeout>=1000&&timeout<=1800000,'Invalid hook timeout');
  return {command:value.command,args:value.args,cwd:path.resolve(cwd,value.cwd || '.'),timeout_ms:timeout};
}
async function inputsDigest(root,plan) {
  const refs=[];for(const ref of plan.references)refs.push(await checksum(fileAt(root,ref)));
  return digestOf({plan,refs});
}
export async function prepareMatrix(specFile,destination) {
  check(specFile && destination,'Use matrix batch-spec.json new-batch-dir');
  specFile=path.resolve(specFile);destination=path.resolve(destination);
  const spec=await read(specFile),base=path.dirname(specFile);
  check(spec.schema==='hypit.ecommerce.matrix-input.v1','Unknown matrix input schema');
  const settings=await loadSettings(base),preferences=settings?.preferences || {};
  const generation=generationChoice(spec.generation || settings?.generation);
  const musicLibrary=Object.hasOwn(spec,'music_library')?spec.music_library:preferences.music_library;
  const repeat=spec.repeat ?? 1;check(Number.isInteger(repeat)&&repeat>=1&&repeat<=100,'Repeat must be 1–100');
  check(Array.isArray(spec.templates)&&spec.templates.length,'Templates required');
  const templates=[],templateIds=new Set();
  for(const entry of spec.templates) {
    const item=typeof entry==='string'?{file:entry}:entry,file=path.resolve(base,item.file),data=validateTemplate(await read(file));
    check(!templateIds.has(data.id),'Duplicate template ID in matrix');templateIds.add(data.id);
    check(!item.background_pool || (Array.isArray(item.background_pool)&&item.background_pool.length&&item.background_pool.every(x=>typeof x==='string'&&x.trim())),'Invalid background_pool');
    templates.push({...item,file,id:data.id});
  }
  check(!(spec.products && spec.products_dir),'Choose products or products_dir');
  let products=spec.products;
  if(spec.products_dir) {
    const directory=path.resolve(base,spec.products_dir);
    products=(await fs.readdir(directory,{withFileTypes:true})).filter(x=>x.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name)).map(x=>({file:path.join(directory,x.name,'product.json'),folder:x.name}));
  }
  check(Array.isArray(products)&&products.length,'Products required');
  const folderIds=new Set();products=products.map(entry=>{
    const item=typeof entry==='string'?{file:entry}:entry,file=path.resolve(base,item.file),folder=folderName(item.folder || path.basename(path.dirname(file)));
    check(!folderIds.has(folder.toLowerCase()),'Duplicate product output folder; supply distinct folder names');folderIds.add(folder.toLowerCase());
    return {...item,file,folder};
  });
  check(products.length*templates.length*repeat<=10000,'Matrix exceeds 10,000 outputs; split into smaller batches');
  check(spec.visual_check===undefined || typeof spec.visual_check==='boolean','visual_check must be true or false');
  const policy={mode:'unattended',visual_check:spec.visual_check ?? preferences.visual_check ?? true,
    speech_similarity:spec.speech_similarity ?? 0.85,speech_coverage:spec.speech_coverage ?? 0.9,
    paid_retries:0,on_failure:'continue',execution:executionSettings(spec.execution ?? preferences.execution),
    music_library:musicLibrary?{path:path.resolve(base,musicLibrary.path),gain:musicLibrary.gain ?? 0.18}:null,
    hook:hookSpec(spec.hook,base)};
  check(Number.isFinite(policy.speech_similarity)&&policy.speech_similarity>=0.8&&policy.speech_similarity<=1&&Number.isFinite(policy.speech_coverage)&&policy.speech_coverage>=0.85&&policy.speech_coverage<=1,'Invalid speech acceptance thresholds');
  if(policy.music_library)check(Number.isFinite(policy.music_library.gain)&&policy.music_library.gain>=0&&policy.music_library.gain<=1,'Invalid music gain');
  const policyDigest=digestOf(policy),jobs=[];
  await fs.mkdir(destination,{recursive:false});
  try {
    for(const product of products)for(const template of templates)for(let i=1;i<=repeat;i++) {
      // Per-template product files/adaptations are prepared once by the caller, not inferred at runtime.
      const productFile=product.variants?.[template.id]?path.resolve(path.dirname(product.file),product.variants[template.id]):product.file;
      const data=await read(productFile),overrides={quality_check:{enabled:policy.visual_check},execution:policy.execution};
      if(spec.fidelity!==undefined)overrides.fidelity=spec.fidelity;
      const adaptation=data.adaptations?.[template.id];
      if(adaptation)overrides.adaptation=adaptation;
      if(template.background_pool)overrides.slots={...data.slots,setting:template.background_pool[(i-1)%template.background_pool.length]};
      const variant='v'+String(i).padStart(3,'0'),relative=['runs',product.folder,template.id,variant].join('/'),run=fileAt(destination,relative);
      await fs.mkdir(path.dirname(run),{recursive:true});
      const plan=await createPlan(template.file,productFile,run,{product:overrides,generation,workspace:base});
      plan.music.library=policy.music_library;
      plan.automation={batch_root:destination,job:relative,policy_digest:policyDigest};
      await save(path.join(run,'plan.json'),plan);
      jobs.push({id:relative,run:relative,product:plan.product,folder:product.folder,template:plan.template,variant:i,
        output:['videos',product.folder,template.id,variant+'.mp4'].join('/'),
        input_digest:await inputsDigest(run,plan),images:plan.frames.length,videos:plan.shots.length,
        video_seconds:plan.shots.reduce((n,s)=>n+s.generation_duration,0),dialogue:plan.audio_mode==='dialogue',music_required:plan.music_required});
    }
    const total=key=>jobs.reduce((n,j)=>n+j[key],0),initial={image:total('images'),video:total('videos')};
    const maximum={image:initial.image*(generation.image==='api'&&generation.fallback.image?2:1),video:initial.video*(generation.video==='api'&&generation.fallback.video?2:1)};
    const limits={image_calls:spec.limits?.image_calls ?? maximum.image,video_calls:spec.limits?.video_calls ?? maximum.video,minimum_free_bytes:spec.limits?.minimum_free_bytes ?? 536870912};
    check(Number.isInteger(limits.image_calls)&&limits.image_calls>=0&&Number.isInteger(limits.video_calls)&&limits.video_calls>=0,'Invalid generation call limits');
    check(Number.isSafeInteger(limits.minimum_free_bytes)&&limits.minimum_free_bytes>=0,'Invalid minimum_free_bytes');
    const batch={schema:'hypit.ecommerce.matrix.v1',created_at:new Date().toISOString(),generation,policy,limits,
      totals:{products:products.length,templates:templates.length,repeat,outputs:jobs.length,initial_tasks:initial,maximum_calls:maximum,video_generation_seconds:total('video_seconds')},jobs};
    await save(path.join(destination,'matrix.json'),batch);
    await save(path.join(destination,'state.json'),{jobs:{}});
    return {status:'planned',batch:destination,...batch.totals,limits,generation,
      ...(!(await loadSettings(base))?.grill_reminder_acknowledged?{reminder:grillReminder}:{}),
      next:'Review matrix.json, then matrix-authorize <batch-dir> "actual user authorization for this finite unattended batch". matrix-check performs no paid generation.',
      warnings:['Generation call caps are not a currency price quote. No automatic paid retries.','Each repeat is a separate real generation, not a copied video. Independence does not guarantee visible differences.']};
  } catch(error) {
    await save(path.join(destination,'preparation-failed.json'),{error:error.message,planned:jobs.length});throw error;
  }
}
async function loadBatch(root) {
  check(root,'Batch directory required');root=path.resolve(root);
  const batch=await read(path.join(root,'matrix.json'));check(batch.schema==='hypit.ecommerce.matrix.v1','Unknown matrix schema');
  for(const job of batch.jobs) {
    const run=fileAt(root,job.run),plan=await read(path.join(run,'plan.json'));
    check(plan.automation?.batch_root===root&&plan.automation.job===job.id&&plan.automation.policy_digest===digestOf(batch.policy),'Batch location or policy changed; prepare a new matrix');
    check(await inputsDigest(run,plan)===job.input_digest,'Batch plan or references changed; prepare a new matrix');
    const quality=await optional(path.join(run,'quality-settings.json'));
    check(!quality || quality.enabled===batch.policy.visual_check,'Quality override conflicts with the fixed unattended policy');
  }
  return {root,batch,digest:digestOf(batch)};
}
export async function authorizeMatrix(root,evidence) {
  check(evidence?.trim(),'Actual user authorization required; do not invent approval evidence');
  return withLock(root,async()=>{
    const loaded=await loadBatch(root),authorization={digest:loaded.digest,evidence:evidence.trim(),mode:'unattended',at:new Date().toISOString()};
    await save(path.join(root,'authorization.json'),authorization);return {status:'authorized',totals:loaded.batch.totals,limits:loaded.batch.limits};
  });
}
async function checkAuthorization(root,batch) {
  const approval=await optional(path.join(root,'authorization.json'));
  check(approval?.mode==='unattended'&&approval.evidence?.trim()&&approval.digest===digestOf(batch),'Authorize the concrete matrix before unattended submission; changed batches need new authorization');
  return approval;
}
async function invokeHook(hook,kind,payload,folder,name) {
  const requestDigest=digestOf({kind,payload}),requestFile=path.join(folder,name+'-request.json'),responseFile=path.join(folder,name+'-response.json');
  await fs.mkdir(folder,{recursive:true});
  // Never treat a response to different media as a current model review.
  const prior=await optional(responseFile);
  if(prior?.request_digest===requestDigest)return prior.result;
  if(prior)throw new Error('Hook response is stale; use a new reviewed attempt');
  await save(requestFile,{schema:'hypit.ecommerce.hook-request.v1',kind,request_digest:requestDigest,payload,
    instruction:'Return {request_digest, result} to the supplied response path. For quality actually view the provided media; metadata is not a visual review. Native results require a real local file and actual generation evidence. No API keys belong in responses.'});
  await timed(path.resolve(folder,'..'),'hook:'+kind,name,()=>new Promise((resolve,reject)=>{
    const child=spawn(hook.command,[...hook.args,requestFile,responseFile],{cwd:hook.cwd,env:process.env,shell:false,stdio:'ignore',windowsHide:true});
    const timer=setTimeout(()=>{child.kill();reject(new Error('Hook timed out; inspect its task before retrying generation'));},hook.timeout_ms);
    child.once('error',()=>{clearTimeout(timer);reject(new Error('Cannot launch configured hook'));});
    child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('Hook failed; inspect its local diagnostic output'));});
  }));
  const result=await read(responseFile);check(result.request_digest===requestDigest && result.result,'Hook response digest/result missing');return result.result;
}
export async function preflightMatrix(root) {
  const loaded=await loadBatch(root),{batch}=loaded,errors=[],warnings=[];
  if(batch.generation.video==='api')try{apimartEndpoints();}catch(e){errors.push(e.message);}
  try{const disk=await fs.statfs(loaded.root);if(disk.bavail*disk.bsize<batch.limits.minimum_free_bytes)errors.push('Free disk space is below minimum_free_bytes');}catch{errors.push('Cannot inspect free disk space');}
  for(const [type,variable] of [['image','COMFLY_API_KEY'],['video','APIMART_API_KEY']]) {
    if(batch.generation[type]==='api'&&!process.env[variable])errors.push(variable+' missing for selected API route');
  }
  const requirements=[];
  for(const type of ['image','video'])if(batch.generation[type]==='native'||batch.generation.fallback[type])requirements.push('native:'+type);
  if(batch.policy.visual_check)requirements.push('quality');
  if(requirements.length) {
    if(!batch.policy.hook)errors.push('Configure a real native/visual hook or select API without fallback and explicitly disable visual checking');
    else try {
      // Unique name prevents a stale capability claim from silently passing a later launch.
      const result=await invokeHook(batch.policy.hook,'capabilities',{required:requirements,at:new Date().toISOString()},path.join(loaded.root,'preflight'),String(Date.now()));
      for(const capability of requirements)if(!result.capabilities?.includes(capability))errors.push('Hook capability unavailable: '+capability);
    }catch(e){errors.push(e.message);}
  }
  for(const [program,label] of [[process.env.HYPIT_ECOMMERCE_FFMPEG || 'ffmpeg','FFmpeg'],[process.env.HYPIT_ECOMMERCE_FFPROBE || 'ffprobe','FFprobe']]) {
    const r=spawnSync(program,['-version'],{stdio:'ignore',timeout:10000,windowsHide:true});if(r.status!==0)errors.push(label+' unavailable');
  }
  if(batch.jobs.some(j=>j.dialogue)) {
    const r=spawnSync(process.env.HYPIT_ECOMMERCE_PYTHON || (process.platform==='win32'?'py':'python3'),['-c','import faster_whisper, pypinyin'],{stdio:'ignore',timeout:30000,windowsHide:true});
    if(r.status!==0)errors.push('Local faster-whisper and pypinyin are required for automatic dialogue and caption checks');
    warnings.push('Prepare/cache the ASR model before leaving a batch unattended; recognition thresholds may reject uncertain speech.');
  }
  const library=batch.policy.music_library;
  if(library) {
    const files=await fs.readdir(library.path,{withFileTypes:true}).catch(()=>[]);
    if(!files.some(x=>x.isFile()&&musicExtensions.has(path.extname(x.name).toLowerCase())))errors.push('Music library missing or empty');
  } else if(batch.jobs.some(j=>j.music_required))errors.push('Music-only templates require music_library');
  else warnings.push('No music library selected; dialogue videos will have no added soundtrack.');
  for(const type of ['image','video'])if(batch.limits[type+'_calls']<batch.totals.initial_tasks[type])warnings.push(type+' call cap is lower than initial task count; the batch may stop early.');
  const result={status:errors.length?'blocked':'ready',errors,warnings,required_capabilities:requirements,totals:batch.totals,limits:batch.limits,paid_generation_calls:0};
  await save(path.join(loaded.root,'preflight.json'),result);return result;
}
async function stopRequested(root) {return exists(path.join(root,'STOP'));}
async function reserveCall(root,batch,job,type,id,origin) {
  return serial(path.resolve(root,'calls.json'),async()=>{
  const error=message=>{const e=new Error(message);e.noFallback=true;return e;};
  if(await stopRequested(root))throw error('STOP requested; no new generation submitted');
  await checkAuthorization(root,batch);
  check(digestOf(await read(path.join(root,'matrix.json')))===digestOf(batch),'Batch changed while running');
  const run=fileAt(root,job.run),plan=await read(path.join(run,'plan.json'));
  check(await inputsDigest(run,plan)===job.input_digest,'Batch plan or references changed while running');
  const file=path.join(root,'calls.json'),ledger=await optional(file) || [],key=[job.id,type,id,origin].join(':');
  if(ledger.some(x=>x.key===key))throw error('Generation reservation already exists without a reusable receipt; reconcile before resubmitting');
  if(ledger.filter(x=>x.type===type).length>=batch.limits[type+'_calls'])throw error(type+' generation call cap reached');
  ledger.push({key,type,origin,job:job.id,id,at:new Date().toISOString()});await save(file,ledger);
  });
}
async function generated(root,batch,job,type,services) {
  const run=fileAt(root,job.run),limit=job[type==='image'?'images':'videos'],operation=type==='image'?services.frames:services.videos;
  for(let step=0;step<=limit;step++) {
    const result=await operation(run,{beforeSubmit:(kind,id)=>reserveCall(root,batch,job,kind,id,'api'),
      imageLimit:services.imageLimit,videoLimit:services.videoLimit,uploadCache:services.uploadCache,
      reviewFrames:ids=>visual(run,batch,'frames',services,ids)});
    if(!result)return;
    check(result.status==='native_fallback_required'&&batch.policy.hook,'Generation requires an unavailable native hook');
    const name='native-'+type+'-'+result.id+'-'+result.api_receipt,folder=path.join(run,'hooks'),response=path.join(folder,name+'-response.json');
    if(!await exists(response))await reserveCall(root,batch,job,type,result.api_receipt,'native');
    const actual=await invokeHook(batch.policy.hook,'native',result,folder,name);
    check(typeof actual.file==='string'&&path.isAbsolute(actual.file)&&actual.evidence?.trim(),'Native hook must return an absolute file and actual evidence');
    await services.importNative(run,type,result.id,actual.file,actual.evidence);
  }
  throw new Error('Native generation exceeded finite item count');
}
async function visual(root,batch,stage,services,ids) {
  if(!batch.policy.visual_check)return;
  try {await services.verifyQuality(root,stage,ids);return;}catch{}
  const request=await services.inspect(root,stage,ids);
  if(request.status==='passed')return;
  const result=await invokeHook(batch.policy.hook,'quality',request,path.join(root,'hooks'),stage+'-'+request.digest);
  const file=path.join(root,'hooks',stage+'-result.json');await save(file,result);await services.recordQuality(root,file);await services.verifyQuality(root,stage,ids);
}
export async function automaticEdit(root,policy) {
  const plan=await read(path.join(root,'plan.json')),edit={automatic:true,reviewed:false,review_source:'automation',shots:[]};
  const quality=policy.visual_check?await optional(path.join(root,'quality','videos-review.json')):null;
  if(quality)await verifyQuality(root,'videos');
  for(const s of plan.shots) {
    const metadata=probe(fileAt(root,`clips/${s.id}.mp4`)),duration=Number(metadata.format.duration);
    check(Number.isFinite(duration)&&duration+0.05>=s.target_duration,'Generated clip is too short');
    check(!s.dialogue.trim()||metadata.streams.some(x=>x.codec_type==='audio'),'Dialogue clip has no audio');
    const selected=!s.dialogue.trim()?quality?.items.find(x=>x.id===s.id&&x.passed)?.trim:null;
    edit.shots.push({id:s.id,start:selected?.start ?? 0,duration:s.dialogue.trim()?duration:selected?.duration ?? s.target_duration,dialogue_complete:false});
  }
  const file=path.join(root,'edit.json');await save(file,edit);
  if(plan.shots.some(s=>s.dialogue.trim())) {
    await alignCaptions(root,file);
    const aligned=await read(path.join(root,'alignment/captions.json')),cues=applyAutomaticSpeech(plan,edit,aligned,policy);
    edit.captions=plan.captions?.enabled===false?false:{reviewed:true,review_source:'local-asr-policy',cues};
    await save(path.join(root,'automatic-speech-check.json'),{source:'local-asr-policy',thresholds:{similarity:policy.speech_similarity,coverage:policy.speech_coverage},transcripts:aligned.transcripts});
  } else edit.captions=false;
  if(policy.music_library)edit.music_library=policy.music_library;
  edit.reviewed=true;edit.evidence='Automatic trim/speech policy under upfront batch authorization; no human review claimed';
  await save(file,edit);return file;
}
export function applyAutomaticSpeech(plan,edit,aligned,policy) {
  const cues=[];let offset=0;
  for(let i=0;i<plan.shots.length;i++) {
    const shot=plan.shots[i],trim=edit.shots[i];
    if(shot.dialogue.trim()) {
      const speech=aligned.transcripts.find(x=>x.id===shot.id),shotCues=aligned.cues.filter(x=>x.shot_id===shot.id);
      check(speech&&speech.similarity>=policy.speech_similarity&&speech.coverage>=policy.speech_coverage&&speech.tail_matched===true&&Number.isFinite(speech.speech_end)&&Number.isFinite(speech.offset)&&shotCues.length,'Automatic speech check failed for '+shot.id+'; no invented dialogue approval');
      check(speech.speech_end<=trim.duration+0.05,'Detected speech exceeds actual clip');
      trim.duration=Math.min(trim.duration,Math.max(shot.target_duration,speech.speech_end+0.18));trim.dialogue_complete=true;
      for(const cue of shotCues)cues.push({...cue,start:Number((offset+cue.start-speech.offset).toFixed(3)),end:Number((offset+cue.end-speech.offset).toFixed(3))});
    }
    offset+=trim.duration;
  }
  return cues;
}
async function exportVideo(root,job) {
  const run=fileAt(root,job.run),source=path.join(run,'final.mp4'),destination=fileAt(root,job.output),sha256=await checksum(source);
  if(await exists(destination))check(await checksum(destination)===sha256,'Output exists with different content; refusing to overwrite');
  else {await fs.mkdir(path.dirname(destination),{recursive:true});await fs.copyFile(source,destination+'.partial');await fs.rename(destination+'.partial',destination);}
  const subtitles=path.join(run,'subtitles.srt');if(await exists(subtitles))await fs.copyFile(subtitles,destination.replace(/\.mp4$/,'.srt'));
  return {output:job.output,sha256};
}
const defaults={frames:generateFrames,videos:generateVideos,importNative,inspect,recordQuality,verifyQuality,edit:automaticEdit,assemble,preflight:preflightMatrix};
export async function runMatrix(root,overrides={}) {
  root=path.resolve(root);const services={...defaults,...overrides};
  return withLock(root,async()=>{
    const {batch}=await loadBatch(root);await checkAuthorization(root,batch);
    const execution=executionSettings(batch.policy.execution || {jobs:batch.policy.concurrency || 1,images:1,videos:1});
    services.imageLimit=limiter(execution.images);services.videoLimit=limiter(execution.videos);services.uploadCache=new Map();
    const preflight=await services.preflight(root);check(preflight.status==='ready','Batch preflight blocked: '+(preflight.errors || []).join('; '));
    const state=await optional(path.join(root,'state.json')) || {jobs:{}};
    const saveState=()=>serial(path.resolve(root,'state.json'),()=>save(path.join(root,'state.json'),state));
    await mapLimit(batch.jobs,execution.jobs,async job=>{
      if(await stopRequested(root))return;
      const run=fileAt(root,job.run),previous=state.jobs[job.id];
      try {
        if(previous?.status==='completed') {
          if(await exists(fileAt(root,job.output)))check(await checksum(fileAt(root,job.output))===previous.sha256,'Delivered output changed; refusing to overwrite');
          else {check(await checksum(path.join(run,'final.mp4'))===previous.sha256,'Completed source changed');await exportVideo(root,job);}
          return;
        }
        // A failed row is skipped on later launches; resume only work interrupted in progress.
        if(['failed','blocked'].includes(previous?.status))return;
        await withLock(run,async()=>{
          const stage=async value=>{state.jobs[job.id]={status:'running',stage:value,at:new Date().toISOString()};await saveState();};
          await stage('frames');await generated(root,batch,job,'image',services);await visual(run,batch,'frames',services);
          await approve(run,'Automatic frame gate under upfront unattended authorization; visual check '+(batch.policy.visual_check?'passed via configured model hook':'explicitly disabled'),{source:'automation'});
          await stage('videos');await generated(root,batch,job,'video',services);await visual(run,batch,'videos',services);
          await stage('finishing');const edit=await timed(run,'edit',job.id,()=>services.edit(run,batch.policy));await timed(run,'assemble',job.id,()=>services.assemble(run,edit));
          state.jobs[job.id]={status:'completed',...await exportVideo(root,job),at:new Date().toISOString()};
        });
      }catch(error) {
        const stopped=await stopRequested(root);
        const receipts=[];
        for(const file of await fs.readdir(path.join(run,'receipts')).catch(()=>[]))if(file.endsWith('.json'))receipts.push(await read(path.join(run,'receipts',file)));
        const uncertain=receipts.some(x=>!['downloaded','failed'].includes(x.status)&&!x.task_id);
        const pending=receipts.some(x=>!['downloaded','failed'].includes(x.status)&&x.task_id);
        state.jobs[job.id]={status:stopped?'interrupted':uncertain?'blocked':pending?'waiting':'failed',reason:String(error.message).replace(/sk-[\w-]+/g,'[redacted]').slice(0,600),at:new Date().toISOString()};
      }
      await save(path.join(run,'diagnostics.json'),await diagnostics(run));
      await saveState();
      console.log(JSON.stringify({job:job.id,...state.jobs[job.id]}));
    });
    return matrixStatus(root);
  });
}
export async function matrixStatus(root) {
  const {batch}=await loadBatch(root),state=await optional(path.join(root,'state.json')) || {jobs:{}},calls=await optional(path.join(root,'calls.json')) || [];
  const jobs=batch.jobs.map(j=>({product:j.folder,template:j.template.id,variant:j.variant,output:j.output,...state.jobs[j.id],status:state.jobs[j.id]?.status || 'pending'}));
  const count=status=>jobs.filter(x=>x.status===status).length;
  const failed=count('failed')+count('blocked');
  const report={status:await stopRequested(root)?'stopped':count('completed')===jobs.length?'completed':count('waiting')?'waiting':failed?'finished_with_failures':'pending',totals:batch.totals,
    completed:count('completed'),failed,waiting:count('waiting'),remaining:jobs.length-count('completed')-failed,
    calls:{image:calls.filter(x=>x.type==='image').length,video:calls.filter(x=>x.type==='video').length},jobs};
  await save(path.join(root,'report.json'),report);return report;
}
