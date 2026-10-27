import path from 'node:path';
import {check,read,save} from './core.mjs';

export const grillReminder='首次使用可开启“拷问模式”，一次问一个问题，把卖点、证据和顾虑聊透后保存为产品档案；也可直接使用已准备的资料，不强制开启。';
export function generationChoice(value) {
  check(value && ['api','native'].includes(value.image) && ['api','native'].includes(value.video),
    'Ask the user to choose API or native generation separately for images and videos; keys do not imply consent');
  check(typeof value.evidence==='string' && value.evidence.trim(),'Record the user generation choice in evidence');
  const fallback=value.fallback || {};
  for(const kind of ['image','video'])check(fallback[kind]===undefined || typeof fallback[kind]==='boolean','Fallback choice must be boolean');
  return {image:value.image,video:value.video,fallback:{image:fallback.image===true,video:fallback.video===true},evidence:value.evidence.trim()};
}
export async function loadSettings(root=process.cwd()) {
  return read(path.join(root,'ecommerce-settings.json')).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
}
export async function setup(root=process.cwd(),choicesFile) {
  root=path.resolve(root);
  if(choicesFile) {
    const input=await read(choicesFile),generation=generationChoice(input.generation);
    check(input.grill_reminder_acknowledged===true,'Tell the user about optional grill mode before recording onboarding');
    await save(path.join(root,'ecommerce-settings.json'),{...await loadSettings(root),schema:'hypit.ecommerce.settings.v1',generation,grill_reminder_acknowledged:true,at:new Date().toISOString()});
  }
  const settings=await loadSettings(root);
  return {status:settings?'configured':'user_choice_required',settings:settings?.generation || null,preferences:settings?.preferences || {},
    ...(!settings?.grill_reminder_acknowledged?{reminder:grillReminder}:{}),
    questions:settings?[]:['生图使用 API 还是当前 Agent 的原生能力？','生视频使用 API 还是当前 Agent 的原生能力？','API 明确失败后是否允许使用原生能力兜底？默认不自动切换。'],
    instruction:'Ask before first production; save actual answers with setup <workspace> <choices.json>. Read existing settings on later runs; do not ask again for settled choices.'};
}
export function routeFor(plan,type) {
  const selected=generationChoice(plan.generation);
  check(['image','video'].includes(type),'Invalid generation type');return selected[type];
}
export async function setRunGeneration(root,choicesFile) {
  const input=await read(choicesFile),generation=generationChoice(input.generation),plan=await read(path.join(root,'plan.json'));
  check(!plan.automation,'Batch plan is immutable; prepare a new matrix to change its route');
  plan.generation=generation;delete plan.fallback;
  await save(path.join(root,'plan.json'),plan);
  return {generation,note:'Plan digest changed. Existing frame approval must be renewed before video generation.'};
}
