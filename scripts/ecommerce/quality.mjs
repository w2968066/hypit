import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {read,save,hash,check,fileAt,media} from './core.mjs';
import {assertNoPending} from './attempts.mjs';

export function probe(file){
  const r=spawnSync(process.env.HYPIT_ECOMMERCE_FFPROBE || 'ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],{encoding:'utf8'});
  check(r.status===0,'Cannot inspect media: '+String(r.stderr || r.error?.message).slice(0,300));return JSON.parse(r.stdout);
}
export async function qualityEnabled(root){
  const p=await read(path.join(root,'plan.json'));
  const override=await read(path.join(root,'quality-settings.json')).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  return override?.enabled ?? p.quality_check?.enabled ?? true;
}
export async function setQuality(root,mode){check(['on','off'].includes(mode),'Use quality on or off');await save(path.join(root,'quality-settings.json'),{enabled:mode==='on'});return {enabled:mode==='on'};}
async function snapshot(root,stage){
  check(['frames','videos'].includes(stage),'Quality stage must be frames or videos');
  await assertNoPending(root,stage==='frames'?'image':'video');
  const p=await read(path.join(root,'plan.json')),items=[];
  for(const item of stage==='frames'?p.frames:p.shots){
    const asset=`${stage==='frames'?'frames':'clips'}/${item.id}.${stage==='frames'?'png':'mp4'}`;
    items.push({id:item.id,asset,sha256:hash(await fs.readFile(fileAt(root,asset)))});
  }
  const refs=[];for(const ref of p.references)refs.push(hash(await fs.readFile(fileAt(root,ref))));
  return {items,digest:hash(JSON.stringify({items,refs,template:p.template,stage}))};
}
export async function inspect(root,stage='videos'){
  if(!await qualityEnabled(root))return {status:'skipped',reason:'Quality check is off; no visual model review requested'};
  const snap=await snapshot(root,stage),folder=path.join(root,'quality',stage);await fs.mkdir(folder,{recursive:true});
  for(const item of snap.items){
    if(stage==='frames')item.previews=[path.resolve(root,item.asset)];
    else {
      const metadata=probe(fileAt(root,item.asset)),duration=Number(metadata.format.duration);item.previews=[];
      for(const [i,fraction] of [0.2,0.5,0.8].entries()){
        const target=path.join(folder,`${item.id}-${i+1}.jpg`);
        media(['-y','-ss',String(duration*fraction),'-i',fileAt(root,item.asset),'-frames:v','1','-q:v','2',target]);item.previews.push(path.resolve(target));
      }
      const sheet=path.join(folder,item.id+'-contact.jpg');
      media(['-y',...item.previews.flatMap(file=>['-i',file]),'-filter_complex','[0:v]scale=360:640[a];[1:v]scale=360:640[b];[2:v]scale=360:640[c];[a][b][c]hstack=inputs=3[out]','-map','[out]','-frames:v','1',sheet]);item.contact_sheet=path.resolve(sheet);
    }
  }
  const p=await read(path.join(root,'plan.json'));
  const manifest={schema:'hypit.ecommerce.visual-review.v1',stage,digest:snap.digest,items:snap.items,references:p.references.map(x=>path.resolve(root,x)),
    checklist:['商品颜色、图案、纽扣和版型是否保持','身体和衣物有无穿模、肢体畸形、物体穿透','人物身份、年龄表现和背景是否连续','坐姿、支撑物和视线是否合理'],
    instruction:'Use an available visual model to VIEW these images against product references. Do not mark passed from file metadata. Return digest, stage, and items with id, passed(boolean), findings(array), evidence(text). Video samples are a screening, not exhaustive frame inspection.'};
  const file=path.join(root,'quality',stage+'-request.json');await save(file,manifest);
  return {status:'model_review_required',manifest:path.resolve(file),...manifest};
}
export async function recordQuality(root,resultFile){
  const result=await read(resultFile),snap=await snapshot(root,result.stage);
  check(result.digest===snap.digest,'Review assets changed or digest missing');
  check(result.items?.length===snap.items.length,'Review every item');
  for(const item of snap.items){const matches=result.items.filter(x=>x.id===item.id);check(matches.length===1,'Missing/duplicate review item');const r=matches[0];check(typeof r.passed==='boolean'&&Array.isArray(r.findings)&&r.evidence?.trim(),'Model findings and visual evidence required');}
  await save(path.join(root,'quality',result.stage+'-review.json'),{...result,reviewed_at:new Date().toISOString()});
  return {status:result.items.every(x=>x.passed)?'passed':'needs_repair',failed:result.items.filter(x=>!x.passed).map(x=>x.id)};
}
export async function verifyQuality(root,stage){
  if(!await qualityEnabled(root))return;
  const snap=await snapshot(root,stage),review=await read(path.join(root,'quality',stage+'-review.json')).catch(e=>{if(e.code==='ENOENT')throw new Error(`Run inspect ${stage} and record an actual model review, or turn quality off for speed`);throw e;});
  check(review.digest===snap.digest && review.items?.length===snap.items.length && snap.items.every(item=>review.items.filter(x=>x.id===item.id&&x.passed===true).length===1),'Visual review failed or assets changed; repair affected items or turn quality off');
}
