import {check,render,hash} from './core.mjs';

export const fidelityModes=['strict','balanced','creative'];
const fields=['start_state','action','end_state','camera','framing','secondary_motion','key_moments'];
const labels={start_state:'起始姿态',action:'动作过程',end_state:'结束姿态',camera:'机位与运镜',framing:'景别与取景',secondary_motion:'发丝、衣物及环境运动'};
export function fidelityChoice(value='balanced') {
  const result=typeof value==='string'?{mode:value}:value;
  check(result&&fidelityModes.includes(result.mode),'fidelity.mode must be strict, balanced or creative');
  check(!result.locks || (Array.isArray(result.locks)&&result.locks.every(x=>[...fields,'dialogue'].includes(x))),'Unknown fidelity lock');
  return {mode:result.mode,locks:result.locks || []};
}
export function validateDirection(d,duration) {
  check(d&&typeof d==='object','Shot direction is required');
  check(typeof d.evidence==='string'&&d.evidence.trim(),'Direction requires observations from the source, not an invented review');
  for(const key of Object.keys(labels))check(typeof d[key]==='string'&&d[key].trim(),`direction.${key} is required (use explicit none when absent)`);
  check(Array.isArray(d.key_moments)&&d.key_moments.length>0,'Record at least one timed key moment');
  let last=-1;
  for(const moment of d.key_moments){check(Number.isFinite(moment.at)&&moment.at>=0&&moment.at<=duration&&moment.at>=last&&typeof moment.action==='string'&&moment.action.trim(),'Invalid key moment; use seconds relative to the source shot');last=moment.at;}
  check(!d.critical || (Array.isArray(d.critical)&&d.critical.every(x=>fields.includes(x))),'Unknown critical direction field');
  const slots=[...JSON.stringify(Object.fromEntries(fields.map(key=>[key,d[key]]))).matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map(x=>x[1]);
  check(!slots.length || (Array.isArray(d.product_slots)&&slots.every(x=>d.product_slots.includes(x))),'Declare every product-specific direction slot in product_slots; do not hide an entire motion in a slot');
  return d;
}
export function directShot(shot,adaptation,variables,fidelity) {
  if(!shot.direction){check(fidelity.mode!=='strict'&&!fidelity.locks.length,`Shot ${shot.id}: strict/locked recreation requires source direction; upgrade this legacy template first`);return null;}
  const original=validateDirection(shot.direction,shot.end-shot.start),patch=adaptation?.direction || {};
  if(fidelity.mode==='strict'||fidelity.locks.includes('dialogue'))check(adaptation?.dialogue===undefined||adaptation.dialogue===shot.dialogue,`Shot ${shot.id}: dialogue is locked; only declared product slots may vary`);
  check(adaptation?.prompt===undefined,`Shot ${shot.id}: use explicit direction changes instead of replacing the entire prompt`);
  check(Object.keys(patch).every(key=>fields.includes(key)),`Shot ${shot.id}: unknown direction override`);
  const locked=new Set([...fidelity.locks,...original.critical || [],...(fidelity.mode==='strict'?fields:fidelity.mode==='balanced'?['action','key_moments']:[])]);
  const changes=[];
  for(const key of Object.keys(patch))if(JSON.stringify(patch[key])!==JSON.stringify(original[key])){
    check(!locked.has(key),`Shot ${shot.id}: ${key} is locked by ${fidelity.mode} recreation`);
    check(adaptation?.reason?.trim(),`Shot ${shot.id}: explain each adaptation before production`);
    changes.push({field:key,before:original[key],after:patch[key],reason:adaptation.reason});
  }
  const selected=validateDirection({...original,...patch},shot.end-shot.start),target={};
  for(const key of Object.keys(labels))target[key]=render(selected[key],variables);
  target.key_moments=selected.key_moments.map(x=>({at:x.at,action:render(x.action,variables)}));
  const prompt=Object.entries(labels).map(([key,label])=>`${label}：${target[key]}`).join('\n')+'\n关键时刻（本镜头内秒数）：'+target.key_moments.map(x=>`${x.at}s ${x.action}`).join('；');
  return {prompt,direction:target,source_direction:original,direction_digest:hash(JSON.stringify(target)),locked:[...locked],changes};
}
