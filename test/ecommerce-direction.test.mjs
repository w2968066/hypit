import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {save,read,createPlan,approve,media} from '../scripts/ecommerce/core.mjs';
import {generateFrames,generateVideos,uploadAsset} from '../scripts/ecommerce/providers.mjs';
import {inspect,recordQuality,verifyQuality} from '../scripts/ecommerce/quality.mjs';
import {mapLimit,diagnostics} from '../scripts/ecommerce/execution.mjs';
import {prepareRetry} from '../scripts/ecommerce/attempts.mjs';
import {automaticEdit} from '../scripts/ecommerce/matrix.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const generation={image:'api',video:'api',fallback:{image:false,video:false},evidence:'Offline test only'};
const direction={evidence:'Synthetic test storyboard: side walk, look back at 1 second. Not analysis of user footage.',start_state:'侧身迈步，目光向前',action:'侧向走动并回头看镜头',end_state:'侧身看向镜头',camera:'平视横向跟拍',framing:'全身',secondary_motion:'风吹发丝和衣摆',key_moments:[{at:1,action:'回眸看镜头'}]};
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'hypit-direction-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function inputs(root,extra={}){
  const template={schema:'hypit.ecommerce.template.v1',id:'motion',version:'2',tier:'basic',reviewed:true,frames:[{id:'scene',prompt:'穿{{product}}，草地上行走'}],shots:[{id:'s1',frame:'scene',start:0,end:2,prompt:'Legacy text must not override observed motion',dialogue:'',direction:structuredClone(direction)}]};
  await save(path.join(root,'template.json'),template);await fs.writeFile(path.join(root,'ref.png'),'fixture');
  await save(path.join(root,'product.json'),{id:'item',generation,references:['ref.png'],slots:{product:'开衫'},...extra});return template;
}
const plan=root=>createPlan(path.join(root,'template.json'),path.join(root,'product.json'),path.join(root,'run'));
async function mockReview(root,ids,passed=true){
  const request=await inspect(root,'frames',ids);if(request.status==='passed')return;
  const file=path.join(root,'fixture-review.json');await save(file,{stage:'frames',digest:request.digest,items:request.items.map(x=>({id:x.id,passed,findings:passed?[]:['Mock wrong pose'],evidence:'OFFLINE fixture reviewer; no actual model used'}))});await recordQuality(root,file);
}
function keys(t){for(const name of ['COMFLY_API_KEY','APIMART_API_KEY']){const prior=process.env[name];process.env[name]='offline-test';t.after(()=>{if(prior===undefined)delete process.env[name];else process.env[name]=prior;});}}
const png=()=>Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(120)]);
const mp4=()=>Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftyp'),Buffer.alloc(120)]);

test('source action drives prompts; locked motions cannot be silently replaced',async t=>{
  const root=await fixture(t);await inputs(root,{fidelity:'strict',adaptation:{reviewed:true,shots:{s1:{direction:{action:'站着看远山'},reason:'Invented shortcut'}}}});
  await assert.rejects(plan(root),/action is locked/);await assert.rejects(fs.access(path.join(root,'run')));
  const product=await read(path.join(root,'product.json'));delete product.adaptation;await save(path.join(root,'product.json'),product);
  const p=await plan(root);assert.match(p.shots[0].prompt,/侧向走动并回头/);assert.doesNotMatch(p.shots[0].prompt,/Legacy text/);assert.match(p.frames[0].prompt,/侧身迈步/);assert.equal(p.fidelity.mode,'strict');
  const report=await read(path.join(root,'run','adaptation-report.json'));assert.equal(report.shots[0].source.evidence,direction.evidence);
});
test('balanced allows explained camera adjustment; creative still honors user locks',async t=>{
  const root=await fixture(t);await inputs(root,{fidelity:'balanced',adaptation:{reviewed:true,shots:{s1:{direction:{camera:'固定机位'},reason:'用户允许局部运镜调整'}}}});
  const p=await plan(root);assert.equal(p.shots[0].changes[0].field,'camera');assert.equal(p.shots[0].direction.action,direction.action);
  const product=await read(path.join(root,'product.json'));product.fidelity={mode:'creative',locks:['camera']};await save(path.join(root,'product.json'),product);
  await assert.rejects(createPlan(path.join(root,'template.json'),path.join(root,'product.json'),path.join(root,'blocked')),/camera is locked/);
});
test('legacy templates remain usable but strict claims require actual source analysis',async t=>{
  const root=await fixture(t),template=await inputs(root);delete template.shots[0].direction;await save(path.join(root,'template.json'),template);
  assert.ok((await plan(root)).caveats.some(x=>x.includes('Legacy')));
  const product=await read(path.join(root,'product.json'));product.fidelity='strict';await save(path.join(root,'product.json'),product);
  await assert.rejects(createPlan(path.join(root,'template.json'),path.join(root,'product.json'),path.join(root,'strict')),/requires source direction/);
});
test('freeform override cannot bypass structured direction and incompatible starting frames are rejected',async t=>{
  const root=await fixture(t),template=await inputs(root,{adaptation:{reviewed:true,shots:{s1:{prompt:'Do something else'}}}});
  await assert.rejects(plan(root),/entire prompt/);
  const product=await read(path.join(root,'product.json'));delete product.adaptation;await save(path.join(root,'product.json'),product);
  template.shots.push({...template.shots[0],id:'s2',start:2,end:4,direction:{...direction,start_state:'坐在长椅上'}});await save(path.join(root,'template.json'),template);
  await assert.rejects(plan(root),/incompatible shot starts/);
});
test('failed parallel work drains active requests and does not start remaining requests',async()=>{
  let finished=false,third=false;
  await assert.rejects(mapLimit([1,2,3],2,async n=>{if(n===1){await wait(5);throw new Error('failure');}if(n===2){await wait(35);finished=true;}else third=true;}),/failure/);
  assert.equal(finished,true);assert.equal(third,false);
});
test('parent quality gates children; passed parents are not reviewed twice',async t=>{
  keys(t);const root=await fixture(t);
  await save(path.join(root,'plan.json'),{generation,image_model:'test',references:[],frames:[{id:'scene',prompt:'Scene'},{id:'left',parent:'scene',prompt:'Left'},{id:'right',parent:'scene',prompt:'Right'}],shots:[],quality_check:{enabled:true},execution:{images:2}});
  let posts=0,active=0,peak=0;const transport=async(url,opts)=>{
    if(opts.method==='POST'){posts++;return {task_id:'task'+posts};}
    if(opts.binary){active++;peak=Math.max(peak,active);await wait(20);active--;return png();}
    return {data:{status:'SUCCESS',data:{data:[{url:'https://example.invalid/image'}]}}};
  };
  const gate=await generateFrames(root,{transport});assert.equal(gate.status,'frame_review_required');assert.equal(posts,1);
  await mockReview(root,['scene']);await generateFrames(root,{transport});assert.equal(posts,3);assert.equal(peak,2);
  const request=await inspect(root,'frames');assert.deepEqual(request.items.map(x=>x.id),['left','right']);
  await mockReview(root,['left','right']);await verifyQuality(root,'frames');assert.equal((await inspect(root,'frames')).status,'passed');
  const p=await read(path.join(root,'plan.json'));p.frames[0].prompt='Changed intended pose';await save(path.join(root,'plan.json'),p);await assert.rejects(verifyQuality(root,'frames',['scene']),/changed/);
});
test('quality failure does not generate children or automatically pay for a replacement',async t=>{
  keys(t);const root=await fixture(t);await save(path.join(root,'plan.json'),{generation,references:[],frames:[{id:'scene',prompt:'Scene'},{id:'close',parent:'scene',prompt:'Close'}],shots:[]});
  let posts=0;const transport=async(url,opts)=>opts.method==='POST'?(posts++,{task_id:'task'}):opts.binary?png():{data:{status:'SUCCESS',data:{data:[{url:'https://example.invalid/image'}]}}};
  await assert.rejects(generateFrames(root,{transport,reviewFrames:ids=>mockReview(root,ids,false)}),/review failed/);assert.equal(posts,1);
  await assert.rejects(generateFrames(root,{transport,reviewFrames:ids=>mockReview(root,ids,false)}),/review failed/);assert.equal(posts,1);
});
test('video tasks run concurrently, reuse uploads, preserve request audit, and resume without POST',async t=>{
  keys(t);const root=await fixture(t);await fs.mkdir(path.join(root,'frames'));await fs.writeFile(path.join(root,'frames/scene.png'),'scene bytes');
  const p={generation,pipeline_version:2,tier:'basic',video_model:'fixture',references:[],frames:[{id:'scene'}],quality_check:{enabled:false},execution:{videos:3},shots:[1,2,3].map(i=>({id:'s'+i,frame:'scene',prompt:'Walk then turn',dialogue:'',generation_duration:6,target_duration:2}))};await save(path.join(root,'plan.json'),p);await approve(root,'Offline fixture');
  let uploads=0,posts=0,active=0,peak=0;
  const transport=async(url,opts)=>{
    if(url.endsWith('/uploads/images')){uploads++;await wait(10);return {url:'https://example.invalid/ref'};}
    if(opts.method==='POST'){posts++;return {data:[{task_id:'task'+posts}]};}
    if(opts.binary){active++;peak=Math.max(peak,active);await wait(20);active--;return mp4();}
    return {data:{status:'completed',result:{videos:[{url:'https://example.invalid/video'}]}}};
  };
  await generateVideos(root,{transport});assert.equal(uploads,1);assert.equal(posts,3);assert.equal(peak,3);
  const actual=await read(path.join(root,'requests/video-s1.json'));assert.match(actual.identity.fields.prompt,/前2秒/);assert.equal(actual.identity.fields.duration,6);assert.equal(actual.identity.fields.video_url,undefined);
  await generateVideos(root,{transport});assert.equal(posts,3);assert.equal(uploads,1);
  const report=await diagnostics(root);assert.equal(report.phases.video.calls,3);assert.equal(report.receipts.length,3);assert.ok(report.receipts.every(x=>x.provider_wait_ms>=0));
});
test('upload cache separates providers/accounts and evicts failed uploads',async t=>{
  const root=await fixture(t),cache=new Map(),file={bytes:Buffer.from('image'),name:'ref.png',mime:'image/png'},endpoints={upload:'https://a.invalid/upload'};let calls=0;
  const transport=async()=>{calls++;return {url:'https://a.invalid/image'};};
  await Promise.all([1,2,3].map(()=>uploadAsset(root,file,endpoints,'account-a',cache,transport)));assert.equal(calls,1);
  await uploadAsset(root,file,endpoints,'account-b',cache,transport);await uploadAsset(root,file,{upload:'https://b.invalid/upload'},'account-a',cache,transport);assert.equal(calls,3);
  const bad={...file,bytes:Buffer.from('bad')};await assert.rejects(uploadAsset(root,bad,endpoints,'account-a',cache,async()=>{throw new Error('offline failure');}));await uploadAsset(root,bad,endpoints,'account-a',cache,transport);assert.equal(calls,4);
});
test('batch attempts cannot be turned into an unbounded automatic regeneration loop',async t=>{
  const root=await fixture(t);await save(path.join(root,'plan.json'),{automation:{batch_root:'test'},frames:[{id:'scene'}],shots:[]});await assert.rejects(prepareRetry(root,'image','scene','try again'),/zero automatic paid retries/);
});
test('reviewed action window is used for music-only editing, and evidence samples target the used seconds',async t=>{
  const root=await fixture(t);await fs.mkdir(path.join(root,'clips'));media(['-y','-f','lavfi','-i','color=c=blue:s=64x112:r=10','-t','4','-an','-c:v','libx264','-preset','ultrafast',path.join(root,'clips/s1.mp4')]);
  await save(path.join(root,'plan.json'),{references:[],frames:[],shots:[{id:'s1',prompt:'Turn',dialogue:'',target_duration:2,direction}],quality_check:{enabled:true}});
  const request=await inspect(root,'videos');assert.ok(request.items[0].sample_times.includes(1));assert.ok(Math.max(...request.items[0].sample_times)<=2);
  const result=path.join(root,'review.json');await save(result,{stage:'videos',digest:request.digest,items:[{id:'s1',passed:true,findings:[],evidence:'Offline synthetic fixture only',trim:{start:1,duration:2}}]});await recordQuality(root,result);
  const edit=await read(await automaticEdit(root,{visual_check:true}));assert.equal(edit.shots[0].start,1);assert.equal(edit.shots[0].duration,2);
});
