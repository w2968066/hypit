import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {render,validateTemplate,fileAt,save,approve,verifyApproval,withLock,createPlan,read} from '../scripts/ecommerce/core.mjs';
import {parseImage,parseVideo,executeJob,multipart} from '../scripts/ecommerce/providers.mjs';

test('slots are required and substitution does not recursively interpolate product text',()=>{
 assert.equal(render('拍{{focus}}',{focus:'上半身{{other}}'}),'拍上半身{{other}}');assert.throws(()=>render('{{missing}}',{}));
});
test('asset traversal rejected',()=>{assert.throws(()=>fileAt('/tmp/project','../secret'));});
test('unknown tier is not silently downgraded',()=>{assert.throws(()=>validateTemplate({schema:'hypit.ecommerce.template.v1',id:'demo',version:'1',tier:'advanced'}));});
test('provider success requires actual media URL',()=>{
 assert.throws(()=>parseImage({data:{status:'SUCCESS'}}));assert.throws(()=>parseVideo({data:{status:'completed',result:{}}}));
 assert.equal(parseImage({data:{status:'NOT_START'}}).status,'pending');
 assert.equal(parseVideo({data:{status:'failed',error:{message:'bad input'}}}).reason,'bad input');
 assert.throws(()=>parseVideo({data:{status:'invented'}}));
});
test('multipart preserves original image bytes',()=>{
 const bytes=Buffer.from([0,255,1,23]);const result=multipart({model:'gemini-nano-banana-2.1'},[{field:'image',name:'x.png',mime:'image/png',bytes}]);assert.ok(result.body.includes(bytes));assert.ok(result.body.toString().includes('name="image"'));
});
test('uncertain submission cannot create a second paid request',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hypit-ecommerce-'));let count=0;
 const spec={identity:{model:'test'},provider:'comfly',prepare:async()=>({}),submit:'https://example.com',taskId:r=>r.id};
 const transport=async()=>{count++;throw new Error('timeout');};
 await assert.rejects(executeJob(root,'test',spec,transport));await assert.rejects(executeJob(root,'test',spec,transport),/unknown/);assert.equal(count,1);await fs.rm(root,{recursive:true});
});
test('editing an approved frame invalidates video permission',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hypit-ecommerce-'));await fs.mkdir(path.join(root,'frames'));
 await save(path.join(root,'plan.json'),{references:[],frames:[{id:'wide'}]});await fs.writeFile(path.join(root,'frames/wide.png'),'original');
 await approve(root,'test review');await verifyApproval(root);await fs.writeFile(path.join(root,'frames/wide.png'),'changed');await assert.rejects(verifyApproval(root),/changed/);await fs.rm(root,{recursive:true});
});
test('concurrent callers cannot submit the same project',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hypit-ecommerce-'));
 await withLock(root,async()=>assert.rejects(withLock(root,async()=>{}),/locked/));await fs.rm(root,{recursive:true});
});
test('category mapping moves all frame and motion focus to upper body',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hypit-ecommerce-'));
 const template={schema:'hypit.ecommerce.template.v1',id:'test',version:'1',tier:'basic',reviewed:true,
 categories:{cardigan:{focus:'上半身',action:'展示门襟'}},frames:[{id:'wide',prompt:'{{focus}} {{action}}'}],
 shots:[{id:'s1',start:0,end:2,frame:'wide',prompt:'{{focus}} {{action}}',dialogue:'{{product}}'}]};
 await save(path.join(root,'template.json'),template);await fs.writeFile(path.join(root,'ref.png'),'fixture');
 await save(path.join(root,'product.json'),{id:'item',category:'cardigan',slots:{product:'开衫'},references:['ref.png']});
 const p=await createPlan(path.join(root,'template.json'),path.join(root,'product.json'),path.join(root,'run'));
 assert.equal(p.frames[0].prompt,'上半身 展示门襟');assert.equal(p.shots[0].prompt,p.frames[0].prompt);
 assert.equal(p.shots[0].generation_duration,6);assert.equal(p.shots[0].target_duration,2);
 const product=await read(path.join(root,'product.json'));product.category='unsupported';await save(path.join(root,'product.json'),product);
 await assert.rejects(createPlan(path.join(root,'template.json'),path.join(root,'product.json'),path.join(root,'bad')),/Missing slot/);
 product.adaptation={reviewed:true,slots:{focus:'手持商品',action:'展示包装'}};await save(path.join(root,'product.json'),product);
 const adapted=await createPlan(path.join(root,'template.json'),path.join(root,'product.json'),path.join(root,'adapted'));
 assert.equal(adapted.frames[0].prompt,'手持商品 展示包装');assert.equal(adapted.image_size,'4K');
 await fs.rm(root,{recursive:true});
});
test('resume known receipt downloads without submitting again',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hypit-ecommerce-'));let posts=0;
 const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(120)]);
 const spec={identity:{model:'test'},provider:'comfly',prepare:async()=>({}),submit:'https://example.com/submit',query:'https://example.com/task/',output:'frames/a.png',taskId:r=>r.id,parse:parseImage};
 const transport=async(url,options)=>{if(options.method==='POST'){posts++;return {id:'abc'};}if(options.binary)return bytes;return {data:{status:'SUCCESS',data:{data:[{url:'https://example.com/output'}]}}};};
 await executeJob(root,'test',spec,transport);await fs.unlink(path.join(root,'frames/a.png'));await executeJob(root,'test',spec,transport);assert.equal(posts,1);await fs.rm(root,{recursive:true});
});
test('main hypit entry exposes ecommerce without TypeScript runtime setup',()=>{
 const entry=fileURLToPath(new URL('../bin/hypit.mjs',import.meta.url));
 const r=spawnSync(process.execPath,[entry,'ecommerce','--help'],{encoding:'utf8'});
 assert.equal(r.status,0);assert.ok(JSON.parse(r.stdout).commands['batch-videos']);
});
test('batch approval reports missing frames while preserving valid product approval',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'hypit-ecommerce-'));
 await save(path.join(root,'batch.json'),[{product:'missing',status:'planned'},{product:'valid',status:'planned'}]);
 for(const name of ['missing','valid'])await save(path.join(root,name,'plan.json'),{references:[],frames:[{id:'wide'}]});
 await fs.mkdir(path.join(root,'valid','frames'));await fs.writeFile(path.join(root,'valid','frames','wide.png'),'fixture');
 const entry=fileURLToPath(new URL('../bin/hypit.mjs',import.meta.url));
 const r=spawnSync(process.execPath,[entry,'ecommerce','batch-approve',root,'fixture review'],{encoding:'utf8'});
 assert.equal(r.status,0);const result=JSON.parse(r.stdout);assert.equal(result[0].status,'failed');assert.equal(result[1].status,'complete');await verifyApproval(path.join(root,'valid'));
 await fs.rm(root,{recursive:true});
});
