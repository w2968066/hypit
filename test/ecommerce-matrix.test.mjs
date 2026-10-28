import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {save,read,createPlan,verifyApproval,media,hash} from '../scripts/ecommerce/core.mjs';
import {setup,loadSettings,setRunGeneration} from '../scripts/ecommerce/settings.mjs';
import {generateFrames,executeJob} from '../scripts/ecommerce/providers.mjs';
import {prepareMatrix,authorizeMatrix,runMatrix,matrixStatus,preflightMatrix,applyAutomaticSpeech} from '../scripts/ecommerce/matrix.mjs';
import {probe} from '../scripts/ecommerce/quality.mjs';

const generation={image:'api',video:'api',fallback:{image:false,video:false},evidence:'Test user chose API for both; no fallback'};
async function fixture(t,products=1,templates=1,repeat=1,extra={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hypit-matrix-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const spec={schema:'hypit.ecommerce.matrix-input.v1',products_dir:'products',templates:[],generation,repeat,visual_check:false,execution:{jobs:1},...extra};
  for(let i=0;i<products;i++) {
    const folder=path.join(root,'products','款式 '+i);await save(path.join(folder,'product.json'),{id:'p'+i,references:['ref.png'],facts:{description:'Known product '+i},slots:{product:'Product '+i}});await fs.writeFile(path.join(folder,'ref.png'),'test reference');
  }
  for(let i=0;i<templates;i++) {
    const name='template-'+i+'.json';await save(path.join(root,name),{schema:'hypit.ecommerce.template.v1',id:'template-'+i,version:'1',tier:'basic',reviewed:true,frames:[{id:'scene',prompt:'{{product}}'}],shots:[{id:'s1',frame:'scene',start:0,end:2,prompt:'{{product}}',dialogue:''}]});spec.templates.push(name);
  }
  const specFile=path.join(root,'spec.json');await save(specFile,spec);return {root,specFile,batch:path.join(root,'batch')};
}
function mockRuntime(counters,options={}) {
  return {
    preflight:async()=>({status:'ready'}),
    frames:async(root,{beforeSubmit})=>{
      try{await fs.access(path.join(root,'frames/scene.png'));return;}catch{}
      await beforeSubmit('image','image-scene');counters.images++;
      if(options.failFirst && counters.images===1)throw new Error('Mock terminal provider failure');
      await fs.mkdir(path.join(root,'frames'),{recursive:true});await fs.writeFile(path.join(root,'frames/scene.png'),'mock frame');
      if(options.stopOnce&&counters.images===1)await fs.writeFile(path.join(options.stopOnce,'STOP'),'test stop');
    },
    videos:async(root,{beforeSubmit})=>{
      await verifyApproval(root);await beforeSubmit('video','video-s1');counters.videos++;
      await fs.mkdir(path.join(root,'clips'),{recursive:true});await fs.writeFile(path.join(root,'clips/s1.mp4'),'mock clip');
    },
    edit:async root=>{const file=path.join(root,'edit.json');await save(file,{mock:true});return file;},
    assemble:async root=>{const plan=await read(path.join(root,'plan.json'));await fs.writeFile(path.join(root,'final.mp4'),'Mock delivery '+plan.automation.job);},
  };
}

test('parallel batch rows respect a shared call cap without lost reservations',async t=>{
  const f=await fixture(t,4,1,1,{execution:{jobs:4,images:2,videos:2},limits:{image_calls:2,video_calls:2}});
  await prepareMatrix(f.specFile,f.batch);await authorizeMatrix(f.batch,'Offline capped parallel batch');
  const counters={images:0,videos:0},result=await runMatrix(f.batch,mockRuntime(counters));
  assert.equal(result.completed,2);assert.equal(result.failed,2);assert.deepEqual(counters,{images:2,videos:2});
  const calls=await read(path.join(f.batch,'calls.json'));assert.equal(calls.length,4);assert.equal(new Set(calls.map(x=>x.key)).size,4);
});

test('parallel rows share provider slots and retain all completed states',async t=>{
  const f=await fixture(t,4,1,1,{execution:{jobs:4,images:2,videos:2}});await prepareMatrix(f.specFile,f.batch);await authorizeMatrix(f.batch,'Offline parallel batch');
  const counters={images:0,videos:0},runtime=mockRuntime(counters),frames=runtime.frames;let active=0,peak=0;
  runtime.frames=(root,options)=>options.imageLimit(async()=>{active++;peak=Math.max(peak,active);try{await new Promise(resolve=>setTimeout(resolve,20));await frames(root,options);}finally{active--;}});
  const result=await runMatrix(f.batch,runtime);assert.equal(result.completed,4);assert.equal(peak,2);assert.equal(Object.keys((await read(path.join(f.batch,'state.json'))).jobs).length,4);
});

test('first use asks route choices and mentions grill; settled choices are remembered',async t=>{
  const {root}=await fixture(t);const first=await setup(root);assert.equal(first.status,'user_choice_required');assert.match(first.reminder,/拷问/);assert.equal(first.questions.length,3);
  const file=path.join(root,'choices.json');await save(file,{generation,grill_reminder_acknowledged:true});
  assert.equal((await setup(root,file)).status,'configured');assert.equal((await setup(root)).reminder,undefined);assert.deepEqual((await loadSettings(root)).generation,generation);
});

test('API keys and legacy plan defaults do not select a route; native selection does not call API',async t=>{
  const {root}=await fixture(t);const run=path.join(root,'run');await save(path.join(run,'plan.json'),{frames:[{id:'scene',prompt:'test'}],references:[]});
  await assert.rejects(generateFrames(run),/Ask the user/);
  const choiceFile=path.join(root,'native.json');await save(choiceFile,{generation:{...generation,image:'native'}});await setRunGeneration(run,choiceFile);
  const result=await generateFrames(run);assert.equal(result.route,'native');assert.equal(result.type,'image');assert.equal(result.requested.image_size,'4K');
  await assert.rejects(fs.access(path.join(run,'receipts/image-scene.json')));
});

test('API route does not silently fall back without explicit permission',async t=>{
  const {root}=await fixture(t);await save(path.join(root,'plan.json'),{generation,frames:[{id:'scene',prompt:'test'}],references:[]});
  const key=process.env.COMFLY_API_KEY;delete process.env.COMFLY_API_KEY;
  try{await assert.rejects(generateFrames(root),/COMFLY_API_KEY missing/);await assert.rejects(fs.access(path.join(root,'native-fallback')));}
  finally{if(key!==undefined)process.env.COMFLY_API_KEY=key;}
});

test('5 products × 5 templates × 2 yields 50 independent runs and correctly grouped outputs',async t=>{
  const f=await fixture(t,5,5,2),planned=await prepareMatrix(f.specFile,f.batch);
  assert.equal(planned.outputs,50);assert.deepEqual(planned.initial_tasks,{image:50,video:50});
  const batch=await read(path.join(f.batch,'matrix.json'));assert.equal(new Set(batch.jobs.map(x=>x.run)).size,50);assert.equal(new Set(batch.jobs.map(x=>x.output)).size,50);
  assert.ok(batch.jobs.every(x=>x.output.startsWith('videos/款式 ')));
  const counters={images:0,videos:0},runtime=mockRuntime(counters);
  await assert.rejects(runMatrix(f.batch,runtime),/Authorize/);assert.equal(counters.images,0);
  await authorizeMatrix(f.batch,'Mock user requested this exact unattended 50-video matrix');
  const report=await runMatrix(f.batch,runtime);assert.equal(report.completed,50);assert.equal(report.failed,0);assert.deepEqual(counters,{images:50,videos:50});
  await runMatrix(f.batch,runtime);assert.deepEqual(counters,{images:50,videos:50});
  const job=batch.jobs[0];await fs.unlink(path.join(f.batch,job.output));await runMatrix(f.batch,runtime);assert.deepEqual(counters,{images:50,videos:50});assert.ok(await fs.stat(path.join(f.batch,job.output)));
  assert.equal((await read(path.join(f.batch,job.run,'approval.json'))).source,'automation');
});

test('one terminal failure is isolated, retained, and never silently resubmitted',async t=>{
  const f=await fixture(t,3);await prepareMatrix(f.specFile,f.batch);await authorizeMatrix(f.batch,'Mock user authorized three jobs');
  const counters={images:0,videos:0},runtime=mockRuntime(counters,{failFirst:true});let report=await runMatrix(f.batch,runtime);
  assert.equal(report.failed,1);assert.equal(report.completed,2);report=await runMatrix(f.batch,runtime);
  assert.equal(report.failed,1);assert.equal(counters.images,3);assert.equal(counters.videos,2);
});

test('call cap prevents submission and does not roll into automatic paid retries',async t=>{
  const f=await fixture(t,2,1,1,{limits:{image_calls:1,video_calls:1}});await prepareMatrix(f.specFile,f.batch);await authorizeMatrix(f.batch,'Mock low-cap batch');
  const counters={images:0,videos:0},report=await runMatrix(f.batch,mockRuntime(counters));
  assert.equal(report.completed,1);assert.equal(report.failed,1);assert.deepEqual(counters,{images:1,videos:1});assert.match(report.jobs[1].reason,/cap reached/);
});

test('STOP pauses new requests; resume reuses completed assets instead of spending again',async t=>{
  const f=await fixture(t,2);await prepareMatrix(f.specFile,f.batch);await authorizeMatrix(f.batch,'Mock user authorized two jobs');
  const counters={images:0,videos:0},runtime=mockRuntime(counters,{stopOnce:f.batch});
  let result=await runMatrix(f.batch,runtime);assert.equal(result.status,'stopped');assert.deepEqual(counters,{images:1,videos:0});
  await fs.unlink(path.join(f.batch,'STOP'));result=await runMatrix(f.batch,runtime);assert.equal(result.completed,2);assert.deepEqual(counters,{images:2,videos:2});
});

test('modified plans or references invalidate a prepared batch before any new work',async t=>{
  const f=await fixture(t);await prepareMatrix(f.specFile,f.batch);await authorizeMatrix(f.batch,'Mock user authorization');const batch=await read(path.join(f.batch,'matrix.json'));
  await fs.writeFile(path.join(f.batch,batch.jobs[0].run,'references/input-1.png'),'changed');
  await assert.rejects(runMatrix(f.batch,mockRuntime({images:0,videos:0})),/references changed/);
});

test('duplicate output folder names and missing adaptation slots fail during planning',async t=>{
  const f=await fixture(t,2),spec=await read(f.specFile);spec.products=[{file:'products/款式 0/product.json',folder:'same'},{file:'products/款式 1/product.json',folder:'SAME'}];delete spec.products_dir;await save(f.specFile,spec);
  await assert.rejects(prepareMatrix(f.specFile,f.batch),/Duplicate product output/);
  spec.products=spec.products.slice(0,1);await save(f.specFile,spec);const template=await read(path.join(f.root,'template-0.json'));template.frames[0].prompt='{{missing_focus}}';await save(path.join(f.root,'template-0.json'),template);
  await assert.rejects(prepareMatrix(f.specFile,f.batch),/Missing slot/);await assert.rejects(fs.access(path.join(f.batch,'matrix.json')));
});

test('pre-submit budget failure never reaches a paid POST or writes a submission receipt',async t=>{
  const {root}=await fixture(t);let posts=0;
  await assert.rejects(executeJob(root,'bounded',{identity:{test:true},prepare:async()=>({}),beforeSubmit:async()=>{throw new Error('cap reached');}},async()=>{posts++;}),/cap reached/);
  assert.equal(posts,0);await assert.rejects(fs.access(path.join(root,'receipts/bounded.json')));
});

test('unattended native route and visual checking require a real hook before generation',async t=>{
  const f=await fixture(t,1,1,1,{generation:{...generation,image:'native',video:'native'},visual_check:true});await prepareMatrix(f.specFile,f.batch);
  const preflight=await preflightMatrix(f.batch);assert.equal(preflight.status,'blocked');assert.ok(preflight.errors.some(x=>/real native\/visual hook/.test(x)));assert.equal(preflight.paid_generation_calls,0);
});

test('known pending tasks resume, while unknown submissions are blocked instead of resubmitted',async t=>{
  for(const known of [true,false]) {
    const f=await fixture(t),counters={images:0,videos:0};await prepareMatrix(f.specFile,f.batch);await authorizeMatrix(f.batch,'Mock user batch authorization');
    const runtime=mockRuntime(counters),generate=runtime.frames;let first=true;
    runtime.frames=async(root,options)=>{
      if(first){first=false;await options.beforeSubmit('image','image-scene');counters.images++;await save(path.join(root,'receipts/image-scene.json'),{status:'submitted',...(known?{task_id:'existing-task'}:{})});throw new Error('Mock interrupted provider query');}
      // A receipt-aware provider resumes the existing request without calling beforeSubmit again.
      await save(path.join(root,'receipts/image-scene.json'),{status:'downloaded',task_id:'existing-task'});await fs.mkdir(path.join(root,'frames'));await fs.writeFile(path.join(root,'frames/scene.png'),'resumed frame');
    };
    let result=await runMatrix(f.batch,runtime);assert.equal(result.jobs[0].status,known?'waiting':'blocked');
    result=await runMatrix(f.batch,runtime);assert.equal(result.jobs[0].status,known?'completed':'blocked');assert.equal(counters.images,1);
  }
});

test('automatic speech gate rejects a missing sentence ending even with high overall similarity',()=>{
  const plan={shots:[{id:'s1',dialogue:'完整的产品对白结尾',target_duration:2}]},edit={shots:[{id:'s1',duration:6}]},aligned={transcripts:[{id:'s1',similarity:0.98,coverage:0.98,tail_matched:false,speech_end:3,offset:0}],cues:[{shot_id:'s1',start:0,end:3,text:'完整的产品对白结尾'}]};
  assert.throws(()=>applyAutomaticSpeech(plan,edit,aligned,{speech_similarity:0.85,speech_coverage:0.9}),/speech check failed/);assert.notEqual(edit.shots[0].dialogue_complete,true);
});

test('automatic speech gate preserves a long sentence and retimes later captions after silence removal',()=>{
  const plan={shots:[{id:'s1',dialogue:'第一句',target_duration:2},{id:'s2',dialogue:'第二句',target_duration:2}]},edit={shots:[{id:'s1',duration:6},{id:'s2',duration:6}]};
  const aligned={transcripts:[{id:'s1',similarity:1,coverage:1,tail_matched:true,speech_end:3,offset:0},{id:'s2',similarity:1,coverage:1,tail_matched:true,speech_end:2,offset:6}],cues:[{shot_id:'s1',start:0.2,end:3,text:'第一句'},{shot_id:'s2',start:6.2,end:8,text:'第二句'}]};
  const cues=applyAutomaticSpeech(plan,edit,aligned,{speech_similarity:0.85,speech_coverage:0.9});assert.equal(edit.shots[0].duration,3.18);assert.equal(cues[1].start,3.38);assert.equal(cues[1].end,5.18);assert.ok(edit.shots.every(x=>x.dialogue_complete));
});

test('per-template adaptation and background rotation are fixed before repeats run',async t=>{
  const f=await fixture(t,1,1,2),productFile=path.join(f.root,'products/款式 0/product.json'),product=await read(productFile),spec=await read(f.specFile);
  product.adaptations={'template-0':{reviewed:true,slots:{focus:'上半身门襟'}}};await save(productFile,product);
  const templateFile=path.join(f.root,'template-0.json'),template=await read(templateFile);template.frames[0].prompt='{{product}} {{focus}} {{setting}}';await save(templateFile,template);
  spec.templates=[{file:'template-0.json',background_pool:['背景甲','背景乙']}];await save(f.specFile,spec);await prepareMatrix(f.specFile,f.batch);
  const batch=await read(path.join(f.batch,'matrix.json')),plans=await Promise.all(batch.jobs.map(j=>read(path.join(f.batch,j.run,'plan.json'))));
  assert.match(plans[0].frames[0].prompt,/上半身门襟 背景甲/);assert.match(plans[1].frames[0].prompt,/上半身门襟 背景乙/);
});

test('native and quality hooks check parent before child, then assemble/export without duplicate reviews',async t=>{
  const f=await fixture(t,1,1,1,{generation:{...generation,image:'native',video:'native'},visual_check:true,music_library:{path:'music'},hook:{command:process.execPath,args:['hook.mjs']}});
  const templateFile=path.join(f.root,'template-0.json'),template=await read(templateFile);template.frames.push({id:'close',parent:'scene',prompt:'Close product view'});template.shots[0].frame='close';await save(templateFile,template);
  // Offline mock generator supplies real synthetic media, never calls a model/provider.
  media(['-y','-f','lavfi','-i','color=c=blue:s=720x1280:r=30','-t','2','-an','-c:v','libx264','-preset','ultrafast',path.join(f.root,'synthetic.mp4')]);
  media(['-y','-i',path.join(f.root,'synthetic.mp4'),'-frames:v','1',path.join(f.root,'synthetic.png')]);
  await fs.mkdir(path.join(f.root,'music'));media(['-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','1',path.join(f.root,'music/tone.wav')]);
  await fs.writeFile(path.join(f.root,'hook.mjs'),`import fs from 'node:fs/promises';import path from 'node:path';const [request,response]=process.argv.slice(2),r=JSON.parse(await fs.readFile(request,'utf8'));let result;
  if(r.kind==='capabilities')result={capabilities:['native:image','native:video','quality']};
  else if(r.kind==='quality'){
    const seen=JSON.parse(await fs.readFile('reviews.json','utf8').catch(()=>'[]'));seen.push({stage:r.payload.stage,ids:r.payload.items.map(x=>x.id)});await fs.writeFile('reviews.json',JSON.stringify(seen));
    if(r.payload.stage==='frames'&&r.payload.items.some(x=>x.id==='scene'))await fs.writeFile('parent-reviewed','fixture');
    result={stage:r.payload.stage,digest:r.payload.digest,items:r.payload.items.map(x=>({id:x.id,passed:true,findings:[],evidence:'OFFLINE TEST synthetic media reviewer'}))};
  }else{
    if(r.payload.type==='image'&&r.payload.id==='close')await fs.access('parent-reviewed');
    result={file:path.resolve(r.payload.type==='image'?'synthetic.png':'synthetic.mp4'),evidence:'OFFLINE TEST: synthetic fixture returned by mock native adapter'};
  }await fs.writeFile(response,JSON.stringify({request_digest:r.request_digest,result}));`);
  await prepareMatrix(f.specFile,f.batch);await authorizeMatrix(f.batch,'Mock user authorized one unattended native production');const result=await runMatrix(f.batch);
  assert.equal(result.completed,1);assert.equal(result.failed,0);assert.deepEqual(result.calls,{image:2,video:1});
  const reviews=await read(path.join(f.root,'reviews.json'));assert.deepEqual(reviews.filter(x=>x.stage==='frames').map(x=>x.ids),[['scene'],['close']]);
  const output=path.join(f.batch,result.jobs[0].output),metadata=probe(output),video=metadata.streams.find(x=>x.codec_type==='video');assert.equal(video.width,720);assert.equal(video.height,1280);assert.ok(metadata.streams.some(x=>x.codec_type==='audio'));
  const batch=await read(path.join(f.batch,'matrix.json')),receipt=await read(path.join(f.batch,batch.jobs[0].run,'assembly/music-selection.json'));assert.equal(receipt.chosen,'tone.wav');
  const sha=hash(await fs.readFile(output));await runMatrix(f.batch);assert.equal(hash(await fs.readFile(output)),sha);assert.deepEqual((await matrixStatus(f.batch)).calls,{image:2,video:1});
});
