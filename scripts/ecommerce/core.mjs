import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {fidelityChoice,validateDirection,directShot} from './direction.mjs';
import {executionSettings} from './execution.mjs';

export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
// Production settings do not change product facts or require another interview.
export const productFactsDigest = p => hash(JSON.stringify({id:p.id,category:p.category,facts:p.facts || {description:p.slots?.product_description ?? p.slots?.product ?? p.id},references:p.references}));
export const read = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
export async function save(file, value) {
  await fs.mkdir(path.dirname(file), {recursive:true});
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value, null, 2)); await fs.rename(tmp, file);
}
export function check(ok, message) { if (!ok) throw new Error(message); }
export function fileAt(root, relative) {
  check(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative), 'Expected relative asset path');
  const resolved = path.resolve(root, relative);
  check(resolved.startsWith(path.resolve(root) + path.sep), 'Asset escapes project');
  return resolved;
}
export function render(text, variables) {
  check(typeof text === 'string', 'Prompt must be text');
  return text.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    check(typeof variables[key] === 'string' && variables[key].trim(), `Missing slot: ${key}`);
    return variables[key];
  });
}
export function validateTemplate(t) {
  check(t.schema === 'hypit.ecommerce.template.v1', 'Unknown template schema');
  check(/^[a-z0-9_-]+$/.test(t.id) && typeof t.version === 'string', 'Invalid template identity');
  check(t.tier === 'basic', 'Advanced video-reference mode is not implemented; never silently downgrade');
  check(t.reviewed === true, 'Template analysis must be reviewed before compilation');
  check(Array.isArray(t.frames) && t.frames.length > 0 && Array.isArray(t.shots) && t.shots.length > 0, 'Frames/shots required');
  const ids = new Set();
  for (const f of t.frames) {
    check(/^[a-z0-9_-]+$/.test(f.id) && !ids.has(f.id), 'Duplicate/invalid frame ID');
    check(!f.parent || ids.has(f.parent), 'Frame parent must precede child'); ids.add(f.id);
    check(typeof f.prompt === 'string', 'Frame prompt required');
  }
  const shots = new Set(); let end = 0;
  for (const s of t.shots) {
    check(/^[a-z0-9_-]+$/.test(s.id) && !shots.has(s.id), 'Duplicate/invalid shot ID'); shots.add(s.id);
    check(ids.has(s.frame), 'Shot frame missing');
    check(Number.isFinite(s.start) && Number.isFinite(s.end) && Math.abs(s.start-end)<0.001 && s.end>s.start, 'Shot timeline must be contiguous'); end=s.end;
    check(typeof s.prompt==='string' && typeof s.dialogue==='string', 'Shot prompt/dialogue required');
    if(s.direction)validateDirection(s.direction,s.end-s.start);
  }
  check(!t.categories || typeof t.categories==='object', 'Category presets must be an object');
  return t;
}
export async function describeAdaptation(templateFile,productFile){
  const t=validateTemplate(await read(templateFile)),p=await read(productFile),slots={...t.defaults,...t.categories?.[p.category],...p.adaptation?.slots,...p.slots};
  const {loadSettings}=await import('./settings.mjs'),settings=await loadSettings();
  const fidelity=fidelityChoice(p.fidelity ?? settings?.preferences?.fidelity ?? 'balanced');
  const required=[...new Set(Array.from(JSON.stringify({frames:t.frames,shots:t.shots}).matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g),x=>x[1]))];
  return {template:t.id,narrative:t.narrative || {principle:'Keep the source hook, relationship, evidence and payoff; adapt all product-specific wording and framing.'},
    product:p.id,fidelity,source_shots:t.shots.map(s=>({id:s.id,start:s.start,end:s.end,direction:s.direction})),known:slots,missing:required.filter(key=>!slots[key]),
    instruction:'Read ecommerce-direction.md and original Hypit reference/image/video direction guides when making or changing a template. Category presets are conveniences, not a whitelist. Resolve product slots without inventing facts. Preserve source action and key moments in balanced mode; all direction and dialogue structure in strict mode; always preserve critical fields and user locks. For necessary product adaptations use explicit direction changes plus reason; never silently replace a structured shot prompt. If a product conflicts with a locked motion, explain it instead of weakening fidelity. Legacy templates without source observations require reanalysis before strict claims.'};
}
export function media(args,options={}) {
  const result = spawnSync(process.env.HYPIT_ECOMMERCE_FFMPEG || 'ffmpeg', ['-hide_banner','-loglevel','error',...args], {encoding:'utf8',...options});
  check(result.status===0, 'FFmpeg failed: '+(result.stderr || result.error?.message || '').slice(0,800));
}
export async function compile(analysisFile, source, destination) {
  const t = validateTemplate(await read(analysisFile));
  check(t.shots.every(s=>s.direction),'New templates require source-backed shot direction. Follow docs/guide/ecommerce-direction.md; existing compiled templates remain readable.');
  await fs.mkdir(destination, {recursive:false});
  await fs.mkdir(path.join(destination,'reference_videos'));
  for (const s of t.shots) {
    media(['-ss',String(s.start),'-i',source,'-t',String(s.end-s.start),'-c:v','libx264','-crf','18','-c:a','aac',path.join(destination,'reference_videos',s.id+'.mp4')]);
  }
  // The original mix is evidence, NEVER automatically used as a music-only track.
  media(['-i',source,'-vn','-c:a','pcm_s16le',path.join(destination,'reference-mix.wav')]);
  t.source_sha256=hash(await fs.readFile(source));
  await save(path.join(destination,'template.json'),t);
  return {template:destination,shots:t.shots.length,music:'separation and listening review required'};
}
export async function createPlan(templateFile, productFile, destination, options={}) {
  const t=validateTemplate(await read(templateFile)), p={...await read(productFile),...options.product};
  const {generationChoice,loadSettings}=await import('./settings.mjs');
  const settings=await loadSettings(options.workspace),preferences=settings?.preferences || {};
  const selected=options.generation || p.generation || settings?.generation;
  const generation=selected?generationChoice(selected):null;
  check(typeof p.id==='string' && /^[a-z0-9_-]+$/.test(p.id), 'Product ID must be portable');
  check(p.slots && typeof p.slots==='object' && Array.isArray(p.references) && p.references.length, 'Product slots/references required');
  check(p.references.length<=5,'At most five product references; two video slots are reserved for scene and shot framing');
  check(!p.scene_anchor || t.frames.some(f=>f.id===p.scene_anchor),'Scene anchor must name a template frame');
  check(!('apiKey' in p) && !('key' in p), 'Keys belong in environment, never product JSON');
  let grillBrief=null;
  if(p.grill_mode===true) {
    const profile=await read(path.join(path.dirname(productFile),'product.profile.json')).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    const session=profile?.reviewed ? profile : await read(path.join(path.dirname(productFile),'product.grill.json'));
    check(session.product_id===p.id && session.reviewed===true && session.evidence,
      'Grill interview is not reviewed');
    check(session.facts_digest ? session.facts_digest===productFactsDigest(p) : session.product_sha256===hash(await fs.readFile(productFile)),
      'Product changed after grill review; review the mapped selling points again');
    grillBrief={answers:session.answers,evidence:session.evidence,digest:hash(JSON.stringify(session))};
  }
  check(!p.adaptation || p.adaptation.reviewed===true,'Review the product adaptation before planning');
  for(const id of Object.keys(p.adaptation?.shots || {}))check(t.shots.some(s=>s.id===id),`Unknown adapted shot: ${id}`);
  for(const id of Object.keys(p.adaptation?.frames || {}))check(t.frames.some(f=>f.id===id),`Unknown adapted frame: ${id}`);
  const variables={...t.defaults,...t.categories?.[p.category],...p.adaptation?.slots,...p.slots};
  const fidelity=fidelityChoice(p.fidelity ?? preferences.fidelity ?? 'balanced');
  const execution=executionSettings(p.execution ?? preferences.execution);
  const anchors=(p.adaptation?.physical_anchors || t.physical_anchors || []).map(x=>render(x,variables));
  const constraints=[...anchors,...(variables.focus_guard?[variables.focus_guard]:[])].join('。');
  const prompt=(text,item,rendered=false)=>(rendered?text:render(text,variables))+(constraints?'\n空间与取景约束：'+constraints:'')+(item.constraints?.length?'\n本镜头约束：'+item.constraints.map(x=>render(x,variables)).join('。'):'');
  const shots=t.shots.map(s=>{
    const adapted=p.adaptation?.shots?.[s.id],directed=directShot(s,adapted,variables,fidelity);
    return {...s,...directed,prompt:prompt(directed?.prompt ?? adapted?.prompt ?? s.prompt,s,!!directed),dialogue:render(adapted?.dialogue ?? s.dialogue,variables),
      generation_duration:Math.max(6,Math.ceil(s.end-s.start)),target_duration:Number((s.end-s.start).toFixed(6))};
  });
  const frames=t.frames.map(f=>{
    const starts=shots.filter(s=>s.frame===f.id&&s.direction).map(s=>({pose:s.direction.start_state,framing:s.direction.framing,camera:s.direction.camera}));
    check(new Set(starts.map(x=>JSON.stringify(x))).size<=1,`Frame ${f.id} serves incompatible shot starts; create separate shot frames`);
    const override=p.adaptation?.frames?.[f.id];
    check(!override || override.reason?.trim(),`Frame ${f.id}: explain the product-specific image adaptation`);
    const text=prompt(override?.prompt ?? f.prompt,f)+(starts.length?`\n视频起始画面：${starts[0].pose}\n本镜头取景：${starts[0].framing}\n机位依据：${starts[0].camera}；仅表现该镜头起点的视角，不画运动轨迹或多格图。\n这是动作开始前的状态，不要提前表现结束动作。`:'');
    return {...f,prompt:text};
  });
  for (const s of shots) check(s.generation_duration<=15,'Grok duration exceeds 15 seconds');
  const audioMode=shots.some(s=>s.dialogue.trim())?'dialogue':'music_only';
  await fs.mkdir(destination,{recursive:false}); await fs.mkdir(path.join(destination,'references'));
  const references=[];
  for (let i=0;i<p.references.length;i++) {
    const from=fileAt(path.dirname(productFile),p.references[i]);
    const ext=path.extname(from).toLowerCase(); check(['.png','.jpg','.jpeg','.webp'].includes(ext),'Unsupported image format');
    const to=`references/input-${i+1}${ext}`; await fs.copyFile(from,fileAt(destination,to)); references.push(to);
  }
  const plan={schema:'hypit.ecommerce.plan.v1',pipeline_version:2,tier:'basic',fidelity,execution,template:{id:t.id,version:t.version,digest:hash(JSON.stringify(t))},
    product:p.id,category:p.category,image_model:'gemini-nano-banana-2.1',image_size:p.image_size || '4K',video_model:'grok-imagine-1.5-video-ext',video_resolution:'720p',aspect_ratio:'9:16',scene_anchor:p.scene_anchor || t.frames[0].id,
    audio_mode:audioMode,music_required:audioMode==='music_only',quality_check:{enabled:p.quality_check?.enabled ?? (typeof p.quality_check==='boolean'?p.quality_check:preferences.visual_check ?? true)},captions:{enabled:p.captions?.enabled ?? (p.captions===false?false:t.captions?.enabled ?? audioMode==='dialogue'),safe_area:{left:42,right:145,bottom:315},font_size:38},generation,
    references,frames,shots,music:{status:'user-library',...(Object.hasOwn(preferences,'music_library')?{library:preferences.music_library}:{})},grill:grillBrief,limits:{image_tasks:frames.length,video_tasks:shots.length},
    caveats:['No reference-video input in basic tier','Voice and timing require output review','Generated clips are at least 6s; reviewed trims required',...(!shots.every(s=>s.direction)?['Legacy template lacks structured motion evidence: fidelity is not verified. Reanalyse the source before claiming strict recreation.']:[])]};
  check(['1K','2K','4K'].includes(plan.image_size),'Invalid image size');
  await save(path.join(destination,'plan.json'),plan);
  await save(path.join(destination,'adaptation-report.json'),{fidelity,source_template:plan.template,variables,frames:frames.map(f=>({id:f.id,parent:f.parent,prompt:f.prompt})),shots:shots.map(s=>({id:s.id,source:s.source_direction,target:s.direction,locked:s.locked,changes:s.changes || [],prompt:s.prompt})),warnings:plan.caveats,
    limitation:'Structural checks cannot prove that source observations or free text are visually correct. Review the source once when compiling the template.'});
  return plan;
}
export async function approvalDigest(root) {
  const p=await read(path.join(root,'plan.json')); const items=[hash(JSON.stringify(p))];
  for (const ref of p.references) items.push(hash(await fs.readFile(fileAt(root,ref))));
  for (const f of p.frames) items.push(hash(await fs.readFile(fileAt(root,`frames/${f.id}.png`))));
  return hash(JSON.stringify(items));
}
export async function approve(root,evidence,options={}) {
  check(evidence?.trim(),'Approval evidence required');
  await (await import('./attempts.mjs')).assertNoPending(root,'image');
  await save(path.join(root,'approval.json'),{digest:await approvalDigest(root),source:options.source || 'human',evidence,at:new Date().toISOString()});
}
export async function verifyApproval(root) {
  await (await import('./attempts.mjs')).assertNoPending(root,'image');
  const a=await read(path.join(root,'approval.json'));
  check(a.evidence && a.digest===await approvalDigest(root),'Frames/plan changed or not approved; obtain review again');
}
export async function withLock(root,operation) {
  const target=path.join(root,'.ecommerce-lock');
  let lock;
  try {lock=await fs.open(target,'wx');} catch {throw new Error('Project is locked. Inspect prior process before removing stale lock.');}
  try {await lock.writeFile(String(process.pid)); return await operation();}
  finally {await lock.close();await fs.unlink(target);}
}
