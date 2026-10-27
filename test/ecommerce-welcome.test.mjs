import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {welcome,answerWelcome} from '../scripts/ecommerce/welcome.mjs';
import {loadSettings,setup} from '../scripts/ecommerce/settings.mjs';
import {read,save,createPlan} from '../scripts/ecommerce/core.mjs';
import {prepareMatrix} from '../scripts/ecommerce/matrix.mjs';

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'hypit-welcome-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;
}
async function complete(root,{image='api',video='native',quality='off',music='稍后'}={}) {
  await welcome(root);
  for(const [id,answer] of [['image',image],['video',video],...([image,video].includes('api')?[['fallback','native']]:[]),['intake','grill'],['quality',quality],['music',music],['workflow','unattended']])await answerWelcome(root,id,answer);
  return answerWelcome(root,'confirm','保存');
}
async function product(root) {
  const template={schema:'hypit.ecommerce.template.v1',id:'sample',version:'1',tier:'basic',reviewed:true,frames:[{id:'wide',prompt:'{{product}}'}],shots:[{id:'s1',frame:'wide',start:0,end:2,prompt:'Show {{product}}',dialogue:'你好'}]};
  await save(path.join(root,'template.json'),template);await save(path.join(root,'product.json'),{id:'item',references:['ref.png'],slots:{product:'商品'}});await fs.writeFile(path.join(root,'ref.png'),'test reference');
}

test('welcome asks one question at a time and resumes without activating partial settings',async t=>{
  const root=await fixture(t);let result=await welcome(root);assert.equal(result.question.id,'image');assert.equal(result.paid_generation_calls,0);
  result=await answerWelcome(root,'image','1');assert.equal(result.question.id,'video');assert.equal(await loadSettings(root),null);
  assert.equal((await welcome(root)).question.id,'video');
  await assert.rejects(answerWelcome(root,'confirm','保存'),/请先完成/);assert.equal(await loadSettings(root),null);
});

test('confirmed choices save mixed routes, optional intake and real preferences without authorizing generation',async t=>{
  const root=await fixture(t),result=await complete(root);assert.equal(result.status,'ready');
  const settings=await loadSettings(root);assert.equal(settings.generation.image,'api');assert.equal(settings.generation.video,'native');assert.deepEqual(settings.generation.fallback,{image:true,video:false});
  assert.deepEqual(settings.preferences,{product_intake:'grill',visual_check:false,music_library:null,workflow:'unattended'});
  assert.equal(settings.grill_reminder_acknowledged,true);assert.equal((await welcome(root)).status,'ready');
  assert.deepEqual(result.agent_preferences,{product_intake:'grill',workflow:'unattended'});
  await assert.rejects(fs.access(path.join(root,'authorization.json')));await assert.rejects(fs.access(path.join(root,'calls.json')));
});

test('native-only selection skips irrelevant API fallback and invalid answers never pick a route',async t=>{
  const root=await fixture(t);await welcome(root);await assert.rejects(answerWelcome(root,'image',''),/无法识别/);
  await answerWelcome(root,'image','原生生图');const result=await answerWelcome(root,'video','原生生视频');assert.equal(result.question.id,'intake');
  await assert.rejects(answerWelcome(root,'fallback','允许'),/不适用/);await assert.rejects(answerWelcome(root,'music','missing-folder'),/不存在/);
  assert.equal(await loadSettings(root),null);
});

test('pause at confirmation retains draft; changes only take effect after saving again',async t=>{
  const root=await fixture(t);await complete(root);
  let result=await answerWelcome(root,'quality','on');assert.equal(result.status,'confirm');assert.equal((await loadSettings(root)).preferences.visual_check,false);
  result=await answerWelcome(root,'confirm','稍后');assert.equal(result.status,'paused');assert.equal((await welcome(root)).status,'confirm');
  await answerWelcome(root,'confirm','保存');assert.equal((await loadSettings(root)).preferences.visual_check,true);
});

test('old setup choices are reused and legacy route edits preserve welcome preferences',async t=>{
  const root=await fixture(t),file=path.join(root,'choices.json');await save(file,{generation:{image:'api',video:'api',fallback:{image:false,video:false},evidence:'Previously confirmed fixture choices'},grill_reminder_acknowledged:true});
  await setup(root,file);assert.equal((await welcome(root)).question.id,'intake');
  await complete(root);const input=await read(file);input.generation.image='native';await save(file,input);await setup(root,file);
  assert.equal((await loadSettings(root)).preferences.visual_check,false);const view=await welcome(root);assert.equal(view.status,'ready');assert.match(view.summary.生图,/原生/);
});

test('saved defaults drive future plans and matrices; explicit task overrides win',async t=>{
  const root=await fixture(t),music=path.join(root,'我的音乐');await fs.mkdir(music);await complete(root,{image:'api',video:'api',music});await product(root);
  const plan=await createPlan(path.join(root,'template.json'),path.join(root,'product.json'),path.join(root,'run'),{workspace:root});
  assert.equal(plan.image_size,'4K');assert.equal(plan.quality_check.enabled,false);assert.equal(plan.music.library.path,music);
  const item=await read(path.join(root,'product.json'));item.quality_check=true;await save(path.join(root,'product.json'),item);
  assert.equal((await createPlan(path.join(root,'template.json'),path.join(root,'product.json'),path.join(root,'override'),{workspace:root})).quality_check.enabled,true);
  const spec={schema:'hypit.ecommerce.matrix-input.v1',products:[{file:'product.json',folder:'item'}],templates:['template.json'],repeat:1};await save(path.join(root,'spec.json'),spec);
  await prepareMatrix(path.join(root,'spec.json'),path.join(root,'batch'));let batch=await read(path.join(root,'batch/matrix.json'));
  assert.equal(batch.policy.visual_check,false);assert.equal(batch.policy.music_library.path,music);
  spec.visual_check=true;spec.music_library=null;await save(path.join(root,'spec.json'),spec);await prepareMatrix(path.join(root,'spec.json'),path.join(root,'override-batch'));batch=await read(path.join(root,'override-batch/matrix.json'));
  assert.equal(batch.policy.visual_check,true);assert.equal(batch.policy.music_library,null);const actual=await read(path.join(root,'override-batch',batch.jobs[0].run,'plan.json'));assert.equal(actual.music.library,null);
});

test('different existing image/video fallback choices are retained without reasking',async t=>{
  const root=await fixture(t);await save(path.join(root,'ecommerce-settings.json'),{generation:{image:'api',video:'api',fallback:{image:true,video:false},evidence:'Previously confirmed independent fallback choices'},grill_reminder_acknowledged:true});
  assert.equal((await welcome(root)).question.id,'intake');
  for(const [id,value] of [['intake','provided'],['quality','off'],['music','稍后'],['workflow','guided'],['confirm','保存']])await answerWelcome(root,id,value);
  assert.deepEqual((await loadSettings(root)).generation.fallback,{image:true,video:false});
});

test('bare ecommerce entry starts the guide; piped interactive requests return immediately for the agent',async t=>{
  const root=await fixture(t),entry=fileURLToPath(new URL('../bin/hypit.mjs',import.meta.url));
  for(const args of [['ecommerce'],['ecommerce','welcome',root,'--interactive']]) {
    const result=spawnSync(process.execPath,[entry,...args],{cwd:root,encoding:'utf8',timeout:10000});assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout).question.id,'image');
  }
});
