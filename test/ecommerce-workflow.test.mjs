import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {save,read,createPlan,approve,verifyApproval,describeAdaptation} from '../scripts/ecommerce/core.mjs';
import {grill,grillQuestions,approveGrill,productInfo} from '../scripts/ecommerce/grill.mjs';
import {inspect,recordQuality,verifyQuality,setQuality} from '../scripts/ecommerce/quality.mjs';
import {prepareRetry,jobId,assertNoPending,completeAttempt} from '../scripts/ecommerce/attempts.mjs';
import {generateFrames,generateVideos,executeJob} from '../scripts/ecommerce/providers.mjs';
import {finishCaptions} from '../scripts/ecommerce/finishing.mjs';

async function fixture(t){
  const prefix=path.resolve(os.tmpdir(),'hypit-ecommerce-contract-'),root=await fs.mkdtemp(prefix);
  t.after(async()=>{assert.ok(path.resolve(root).startsWith(prefix));await fs.rm(root,{recursive:true});});return root;
}
async function productFixture(root){
  const template={schema:'hypit.ecommerce.template.v1',id:'universal',version:'1',tier:'basic',reviewed:true,frames:[{id:'scene',prompt:'{{focus}}'}],shots:[{id:'s1',start:0,end:2,frame:'scene',prompt:'{{focus}}',dialogue:'{{benefit}}'}]};
  await save(path.join(root,'template.json'),template);await fs.writeFile(path.join(root,'ref.png'),'reference');
  await save(path.join(root,'product.json'),{id:'tea',category:'tea',references:['ref.png'],facts:{use_case:'日常泡茶'},slots:{focus:'手持茶叶包装展示封口',benefit:'包装图案清晰'}});
  return path.join(root,'product.json');
}
test('universal narrative accepts a non-apparel product and applies agreed defaults',async t=>{
  const root=await fixture(t),product=await productFixture(root),hint=await describeAdaptation(path.join(root,'template.json'),product);
  assert.deepEqual(hint.missing,[]);
  const p=await createPlan(path.join(root,'template.json'),product,path.join(root,'run'));
  assert.equal(p.image_size,'4K');assert.equal(p.video_resolution,'720p');assert.equal(p.aspect_ratio,'9:16');assert.equal(p.scene_anchor,'scene');assert.equal(p.quality_check.enabled,true);assert.equal(p.captions.safe_area.bottom,315);
});
test('approved product knowledge survives render-setting changes and revisions revoke stale knowledge',async t=>{
  const root=await fixture(t),file=await productFixture(root);
  await grill(file);for(const q of grillQuestions)await grill(file,'已核实的测试答案：'+q.id);
  await approveGrill(file,'fixture user review');assert.equal((await grill(file)).reused,true);
  assert.equal((await productInfo(file)).facts.use_case,'日常泡茶');
  const p=await read(file);p.image_size='2K';p.quality_check=false;p.slots.focus='另一模板改拍封口特写';await save(file,p);
  assert.equal((await productInfo(file,'buyer')).status,'approved');
  await createPlan(path.join(root,'template.json'),file,path.join(root,'run'));
  p.facts.use_case='不同的商品事实';await save(file,p);assert.equal((await productInfo(file)).status,'facts_changed');
  await assert.rejects(createPlan(path.join(root,'template.json'),file,path.join(root,'changed-facts')),/changed/);
  await grill(file,'更新后的具体卖点','ranked_points');assert.equal((await productInfo(file)).status,'draft');
  await assert.rejects(createPlan(path.join(root,'template.json'),file,path.join(root,'unreviewed')),/not reviewed/);
});
test('quality can be skipped without model work, but enabled review is bound to actual assets',async t=>{
  const root=await fixture(t);await save(path.join(root,'plan.json'),{frames:[{id:'scene'}],references:['ref.png']});
  await setQuality(root,'off');assert.equal((await inspect(root,'frames')).status,'skipped');await verifyQuality(root,'frames');
  await fs.mkdir(path.join(root,'frames'));await fs.writeFile(path.join(root,'frames/scene.png'),'frame');await fs.writeFile(path.join(root,'ref.png'),'reference');
  await setQuality(root,'on');await assert.rejects(verifyQuality(root,'frames'),/actual model/);
  const manifest=await inspect(root,'frames');const file=path.join(root,'model-review.json');
  await save(file,{stage:'frames',digest:manifest.digest,items:[{id:'scene',passed:true,findings:[],evidence:'Mock model observation for contract test'}]});
  await recordQuality(root,file);await verifyQuality(root,'frames');
  await fs.writeFile(path.join(root,'ref.png'),'changed product');await assert.rejects(verifyQuality(root,'frames'),/changed/);
});
test('single video retry preserves other outputs, and uncertain requests cannot be retried',async t=>{
  const root=await fixture(t);await save(path.join(root,'plan.json'),{frames:[{id:'scene'}],shots:[{id:'s1',frame:'scene'},{id:'s2',frame:'scene'}]});
  await fs.mkdir(path.join(root,'clips'));await fs.writeFile(path.join(root,'clips/s1.mp4'),'old clip');
  await prepareRetry(root,'video','s1','missed final words');assert.equal(await jobId(root,'video','s2'),'video-s2');
  assert.equal(await fs.readFile(path.join(root,'attempts/video-s1-attempt-1/previous.mp4'),'utf8'),'old clip');
  await assert.rejects(assertNoPending(root,'video'),/Pending/);await completeAttempt(root,'video','s1');await assertNoPending(root,'video');
  await save(path.join(root,'receipts','video-s2.json'),{status:'submitting'});
  await assert.rejects(prepareRetry(root,'video','s2','try again'),/reconcile/);
});
test('retrying a parent frame invalidates dependent frames and clips and requires reapproval',async t=>{
  const root=await fixture(t);await save(path.join(root,'plan.json'),{frames:[{id:'scene'},{id:'close',parent:'scene'}],shots:[{id:'s1',frame:'close'}],references:[]});
  await fs.mkdir(path.join(root,'frames'));for(const id of ['scene','close'])await fs.writeFile(path.join(root,'frames',id+'.png'),id);
  await approve(root,'old image review');const result=await prepareRetry(root,'image','scene','scene support incorrect');
  assert.deepEqual(result.affected,['image-scene','image-close','video-s1']);await assert.rejects(verifyApproval(root),/Pending/);
});
test('missing API capability yields an honest native handoff with requested 4K',async t=>{
  const root=await fixture(t);await save(path.join(root,'plan.json'),{frames:[{id:'scene',prompt:'A scene'}],references:[],image_model:'gemini-nano-banana-2.1'});
  const key=process.env.COMFLY_API_KEY;delete process.env.COMFLY_API_KEY;
  try {const result=await generateFrames(root);assert.equal(result.status,'native_fallback_required');assert.equal(result.requested.image_size,'4K');assert.equal(result.type,'image');}
  finally {if(key!==undefined)process.env.COMFLY_API_KEY=key;}
});
test('video handoff uses the configured scene anchor rather than a hard-coded wide frame',async t=>{
  const root=await fixture(t);await save(path.join(root,'plan.json'),{tier:'basic',frames:[{id:'scene'}],references:[],quality_check:{enabled:false},shots:[{id:'s1',frame:'scene',prompt:'Show the product',dialogue:'你好',generation_duration:6}],video_model:'grok'});
  await fs.mkdir(path.join(root,'frames'));await fs.writeFile(path.join(root,'frames/scene.png'),'fixture');await approve(root,'fixture review');
  const key=process.env.APIMART_API_KEY;delete process.env.APIMART_API_KEY;
  try {const result=await generateVideos(root);assert.equal(result.type,'video');assert.ok(result.references[0].endsWith('scene.png'));assert.equal(result.requested.resolution,'720p');}
  finally {if(key!==undefined)process.env.APIMART_API_KEY=key;}
});
test('native handoff cannot bypass an uncertain API submission',async t=>{
  const root=await fixture(t);await save(path.join(root,'plan.json'),{frames:[{id:'scene',prompt:'Scene'}],references:[]});
  await save(path.join(root,'receipts','image-scene.json'),{status:'submitting'});
  const key=process.env.COMFLY_API_KEY;delete process.env.COMFLY_API_KEY;
  try {await assert.rejects(generateFrames(root),/outcome unknown/);}
  finally {if(key!==undefined)process.env.COMFLY_API_KEY=key;}
});
test('explicit provider rejection is terminal while uncertainty remains protected',async t=>{
  const root=await fixture(t),spec={identity:{model:'fixture'},prepare:async()=>({}),submit:'https://example.com',provider:'comfly'};
  await assert.rejects(executeJob(root,'rejected',spec,async()=>{const e=new Error('HTTP 400');e.httpStatus=400;throw e;}));
  assert.equal((await read(path.join(root,'receipts/rejected.json'))).status,'failed');
});
test('captions cannot silently disappear; speed users can explicitly disable them',async t=>{
  const root=await fixture(t),input=path.join(root,'input.mp4'),output=path.join(root,'output.mp4');await fs.writeFile(input,'fixture');
  await assert.rejects(finishCaptions(root,{}, {},input,output),/timings need review/);
  assert.deepEqual(await finishCaptions(root,{captions:false},{},input,output),{enabled:false});assert.equal(await fs.readFile(output,'utf8'),'fixture');
});
