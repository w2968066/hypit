import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

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
  }
  check(!t.categories || typeof t.categories==='object', 'Category presets must be an object');
  return t;
}
export async function describeAdaptation(templateFile,productFile){
  const t=validateTemplate(await read(templateFile)),p=await read(productFile),slots={...t.defaults,...t.categories?.[p.category],...p.adaptation?.slots,...p.slots};
  const required=[...new Set(Array.from(JSON.stringify({frames:t.frames,shots:t.shots}).matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g),x=>x[1]))];
  return {template:t.id,narrative:t.narrative || {principle:'Keep the source hook, relationship, evidence and payoff; adapt all product-specific wording and framing.'},
    product:p.id,known:slots,missing:required.filter(key=>!slots[key]),
    instruction:'Use product facts and references to map this narrative to the current product. Category presets are conveniences, not a whitelist. Resolve missing slots and review adaptation. Non-wearables may need new role actions and dialogue via adaptation.shots; preserve the story logic, not clothing-specific nouns. Never invent product benefits.'};
}
export function media(args,options={}) {
  const result = spawnSync(process.env.HYPIT_ECOMMERCE_FFMPEG || 'ffmpeg', ['-hide_banner','-loglevel','error',...args], {encoding:'utf8',...options});
  check(result.status===0, 'FFmpeg failed: '+(result.stderr || result.error?.message || '').slice(0,800));
}
export async function compile(analysisFile, source, destination) {
  const t = validateTemplate(await read(analysisFile));
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
export async function createPlan(templateFile, productFile, destination) {
  const t=validateTemplate(await read(templateFile)), p=await read(productFile);
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
  const variables={...t.defaults,...t.categories?.[p.category],...p.adaptation?.slots,...p.slots};
  const anchors=(p.adaptation?.physical_anchors || t.physical_anchors || []).map(x=>render(x,variables));
  const constraints=[...anchors,...(variables.focus_guard?[variables.focus_guard]:[])].join('。');
  const prompt=text=>render(text,variables)+(constraints?'\n空间与取景约束：'+constraints:'');
  const frames=t.frames.map(f=>({...f,prompt:prompt(f.prompt)}));
  const shots=t.shots.map(s=>({...s,prompt:prompt(p.adaptation?.shots?.[s.id]?.prompt || s.prompt),dialogue:render(p.adaptation?.shots?.[s.id]?.dialogue || s.dialogue,variables),
    generation_duration:Math.max(6,Math.ceil(s.end-s.start)),target_duration:Number((s.end-s.start).toFixed(6))}));
  for (const s of shots) check(s.generation_duration<=15,'Grok duration exceeds 15 seconds');
  await fs.mkdir(destination,{recursive:false}); await fs.mkdir(path.join(destination,'references'));
  const references=[];
  for (let i=0;i<p.references.length;i++) {
    const from=fileAt(path.dirname(productFile),p.references[i]);
    const ext=path.extname(from).toLowerCase(); check(['.png','.jpg','.jpeg','.webp'].includes(ext),'Unsupported image format');
    const to=`references/input-${i+1}${ext}`; await fs.copyFile(from,fileAt(destination,to)); references.push(to);
  }
  const plan={schema:'hypit.ecommerce.plan.v1',tier:'basic',template:{id:t.id,version:t.version,digest:hash(JSON.stringify(t))},
    product:p.id,category:p.category,image_model:'gemini-nano-banana-2.1',image_size:p.image_size || '4K',video_model:'grok-imagine-1.5-video-ext',video_resolution:'720p',aspect_ratio:'9:16',scene_anchor:p.scene_anchor || t.frames[0].id,
    quality_check:{enabled:p.quality_check?.enabled ?? (p.quality_check!==false)},captions:{enabled:p.captions?.enabled ?? (p.captions!==false),safe_area:{left:42,right:145,bottom:315},font_size:38},fallback:{image:'native-if-available',video:'native-if-available'},
    references,frames,shots,music:{status:'needs_separation_review'},grill:grillBrief,limits:{image_tasks:frames.length,video_tasks:shots.length},
    caveats:['No reference-video input in basic tier','Voice and timing require output review','Generated clips are at least 6s; reviewed trims required']};
  check(['1K','2K','4K'].includes(plan.image_size),'Invalid image size');
  await save(path.join(destination,'plan.json'),plan); return plan;
}
export async function approvalDigest(root) {
  const p=await read(path.join(root,'plan.json')); const items=[hash(JSON.stringify(p))];
  for (const ref of p.references) items.push(hash(await fs.readFile(fileAt(root,ref))));
  for (const f of p.frames) items.push(hash(await fs.readFile(fileAt(root,`frames/${f.id}.png`))));
  return hash(JSON.stringify(items));
}
export async function approve(root,evidence) {
  check(evidence?.trim(),'Human approval evidence required');
  await (await import('./attempts.mjs')).assertNoPending(root,'image');
  await save(path.join(root,'approval.json'),{digest:await approvalDigest(root),evidence,at:new Date().toISOString()});
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
