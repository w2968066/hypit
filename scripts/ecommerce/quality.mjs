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
async function snapshot(root,stage,ids){
  check(['frames','videos'].includes(stage),'Quality stage must be frames or videos');
  await assertNoPending(root,stage==='frames'?'image':'video',ids);
  const p=await read(path.join(root,'plan.json')),items=[];
  const all=stage==='frames'?p.frames:p.shots;
  check(!ids || (ids.length>0&&new Set(ids).size===ids.length&&ids.every(id=>all.some(x=>x.id===id))),'Unknown/duplicate review item');
  const refs=[];for(const ref of p.references)refs.push(hash(await fs.readFile(fileAt(root,ref))));
  for(const item of all.filter(x=>!ids||ids.includes(x.id))){
    const asset=`${stage==='frames'?'frames':'clips'}/${item.id}.${stage==='frames'?'png':'mp4'}`;
    const sha256=hash(await fs.readFile(fileAt(root,asset))),expected=stage==='frames'?{prompt:item.prompt,shots:p.shots?.filter(s=>s.frame===item.id).map(s=>({id:s.id,direction:s.direction}))}:{prompt:item.prompt,dialogue:item.dialogue,direction:item.direction,source_direction:item.source_direction,target_duration:item.target_duration};
    const parent=item.parent?hash(await fs.readFile(fileAt(root,`frames/${item.parent}.png`))):null;
    items.push({id:item.id,asset,sha256,expected,digest:hash(JSON.stringify({sha256,refs,parent,expected,fidelity:p.fidelity}))});
  }
  return {items,digest:hash(JSON.stringify({items,refs,template:p.template,stage}))};
}
async function priorReview(root,stage){return read(path.join(root,'quality',stage+'-review.json')).catch(e=>{if(e.code==='ENOENT')return {items:[]};throw e;});}
export async function inspect(root,stage='videos',ids){
  if(!await qualityEnabled(root))return {status:'skipped',reason:'Quality check is off; no visual model review requested'};
  const initial=await snapshot(root,stage,ids),prior=await priorReview(root,stage);
  const outstanding=initial.items.filter(x=>!prior.items.some(r=>r.id===x.id&&r.digest===x.digest&&r.passed===true)).map(x=>x.id);
  if(!outstanding.length)return {status:'passed',reused:true,stage};
  const snap=await snapshot(root,stage,outstanding),folder=path.join(root,'quality',stage);await fs.mkdir(folder,{recursive:true});
  for(const item of snap.items){
    if(stage==='frames')item.previews=[path.resolve(root,item.asset)];
    else {
      const metadata=probe(fileAt(root,item.asset)),duration=Number(metadata.format.duration);item.previews=[];
      const window=Math.min(duration,item.expected.target_duration || duration);
      const moments=item.expected.direction?.key_moments?.map(x=>x.at) || [];
      const times=[...new Set([0,window*.25,window*.5,window*.75,...moments,window].map(x=>Number(Math.max(0,Math.min(duration-.04,x)).toFixed(3))))].sort((a,b)=>a-b);
      item.sample_times=times;item.video=path.resolve(root,item.asset);
      for(const [i,time] of times.entries()){
        const target=path.join(folder,`${item.id}-${i+1}.jpg`);
        media(['-y','-ss',String(time),'-i',fileAt(root,item.asset),'-frames:v','1','-q:v','2',target]);item.previews.push(path.resolve(target));
      }
      const sheet=path.join(folder,item.id+'-contact.jpg');
      const filters=item.previews.map((_,i)=>`[${i}:v]scale=180:320[a${i}]`).join(';')+';'+item.previews.map((_,i)=>`[a${i}]`).join('')+`hstack=inputs=${item.previews.length}[out]`;
      media(['-y',...item.previews.flatMap(file=>['-i',file]),'-filter_complex',filters,'-map','[out]','-frames:v','1',sheet]);item.contact_sheet=path.resolve(sheet);
    }
  }
  const p=await read(path.join(root,'plan.json'));
  const manifest={schema:'hypit.ecommerce.visual-review.v1',stage,digest:snap.digest,items:snap.items,references:p.references.map(x=>path.resolve(root,x)),
    fidelity:p.fidelity,checklist:['商品颜色、图案、纽扣和版型是否保持','身体和衣物有无穿模、肢体畸形、物体穿透','人物身份和场景是否连续；不要求不同机位背景像素相同','首帧姿态、景别、视线和支撑物是否符合本镜头起点','主要动作、回眸、运镜和关键时刻是否出现在实际剪辑区间；区分人物运动与相机运动'],
    instruction:'Actually VIEW the provided media against references and expected direction. Samples are screening, not proof of all motion. Inspect the local video if timing is uncertain. Return digest, stage, items with id, passed(boolean), findings(array), evidence(text). For a video you may return trim:{start,duration} only after viewing that exact interval and preserving the intended key action. Diagnose prompt_conflict, wrong_reference, generation_error or uncertain before proposing repair. Do not regenerate automatically; do not fail solely for harmless aesthetic differences allowed by fidelity.'};
  const file=path.join(root,'quality',stage+'-request.json');await save(file,manifest);
  return {status:'model_review_required',manifest:path.resolve(file),...manifest};
}
export async function recordQuality(root,resultFile){
  const result=await read(resultFile),snap=await snapshot(root,result.stage,result.items?.map(x=>x.id));
  check(result.digest===snap.digest,'Review assets changed or digest missing');
  check(result.items?.length===snap.items.length,'Review every item');
  for(const item of snap.items){const matches=result.items.filter(x=>x.id===item.id);check(matches.length===1,'Missing/duplicate review item');const r=matches[0];check(typeof r.passed==='boolean'&&Array.isArray(r.findings)&&r.evidence?.trim(),'Model findings and visual evidence required');}
  const prior=await priorReview(root,result.stage),ids=new Set(result.items.map(x=>x.id));
  for(const r of result.items)if(r.trim){
    check(result.stage==='videos'&&Number.isFinite(r.trim.start)&&r.trim.start>=0&&Number.isFinite(r.trim.duration)&&r.trim.duration>0,'Invalid reviewed trim');
    const actual=snap.items.find(x=>x.id===r.id),duration=Number(probe(fileAt(root,actual.asset)).format.duration);
    check(r.trim.start+r.trim.duration<=duration+.01,'Reviewed trim exceeds clip');
    check(Math.abs(r.trim.duration-actual.expected.target_duration)<.05,'Keep planned duration when selecting a reviewed action window');
  }
  await save(path.join(root,'quality',result.stage+'-review.json'),{...result,items:[...prior.items.filter(x=>!ids.has(x.id)),...result.items.map(x=>({...x,digest:snap.items.find(s=>s.id===x.id).digest}))],reviewed_at:new Date().toISOString()});
  return {status:result.items.every(x=>x.passed)?'passed':'needs_repair',failed:result.items.filter(x=>!x.passed).map(x=>x.id)};
}
export async function verifyQuality(root,stage,ids){
  if(!await qualityEnabled(root))return;
  const snap=await snapshot(root,stage,ids),review=await read(path.join(root,'quality',stage+'-review.json')).catch(e=>{if(e.code==='ENOENT')throw new Error(`Run inspect ${stage} and record an actual model review, or turn quality off for speed`);throw e;});
  check(snap.items.every(item=>review.items?.filter(x=>x.id===item.id&&x.digest===item.digest&&x.passed===true).length===1),'Visual review failed or assets/direction changed; diagnose affected items before repair');
}
