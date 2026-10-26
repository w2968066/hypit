import fs from 'node:fs/promises';
import path from 'node:path';
import {check,hash,read,save,productFactsDigest} from './core.mjs';

export const grillQuestions = [
  {id:'buyer',question:'谁会买这件商品、给谁用？最常见的使用场景是什么？',probe:'说具体人群、季节和使用场景；不要只说“所有人都适合”。'},
  {id:'trigger',question:'顾客或模板里的同伴为什么会主动问链接？第一眼注意到了什么？',probe:'用可观察的细节描述，而不是“高级感”“爆款”。'},
  {id:'ranked_points',question:'请按重要性列出最多三个卖点。每个卖点解决什么实际问题？',probe:'只保留这个商品真的有、且目标顾客在意的特点。'},
  {id:'evidence',question:'每个卖点的依据是什么？有商品图、标签参数、实际体验或真实反馈吗？',probe:'分清已证实、亲身体验和未经证实的说法。'},
  {id:'visual_proof',question:'视频里能拍到哪些细节证明这些卖点？哪些必须用近景或特写？',probe:'指出部位、动作和可见纹理；跨品类时明确镜头焦点迁移。'},
  {id:'objections',question:'顾客最可能犹豫什么？规格、使用条件、维护或搭配上有没有真实限制？',probe:'直接说不足和适用边界，避免后续台词过度承诺。'},
  {id:'dialogue',question:'在当前模板的角色关系里，哪句自然对白最能侧面烘托商品？',probe:'让角色说像真人会说的话，保留模板的情绪和节奏。'},
  {id:'red_lines',question:'哪些词、功效或承诺绝对不能说？是否有价格、品牌或平台审核限制？',probe:'把无法证明的“第一”“最”“绝对”等表达列出来。'},
];

const sessionPath = productFile => path.join(path.dirname(path.resolve(productFile)),'product.grill.json');
const profilePath = productFile => path.join(path.dirname(path.resolve(productFile)),'product.profile.json');
async function optional(file){return read(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});}
export async function productInfo(productFile,questionId) {
  const product=await read(productFile), profile=await optional(profilePath(productFile)), session=await optional(sessionPath(productFile));
  const known=profile || session;
  const answers=known?.answers || {};
  return {product:product.id,status:profile?.reviewed ? (profile.facts_digest===productFactsDigest(product)?'approved':'facts_changed') : 'draft',
    answers:questionId ? {[questionId]:answers[questionId] || null} : answers,facts:known?.facts || product.facts || {},slots:product.slots,
    missing:grillQuestions.filter(q=>!answers[q.id]).map(q=>q.id)};
}
const result = (productFile,session) => {
  const index=grillQuestions.findIndex(q=>!session.answers[q.id]);
  if(index<0)return {status:session.reviewed?'approved':'needs_review',session:sessionPath(productFile),answers:session.answers,
    next:'核对答案与商品图片，将已证实卖点写进 product.json 的 slots；用户确认后执行 grill-approve。'};
  return {status:'question',session:sessionPath(productFile),progress:`${index+1}/${grillQuestions.length}`,
    question:grillQuestions[index],product:session.product_id};
};

export async function grill(productFile,answer,questionId) {
  const product=await read(productFile);
  check(typeof product.id==='string' && product.id.trim(),'Product ID required');
  const file=sessionPath(productFile);
  let session=await read(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  const profile=await optional(profilePath(productFile));
  if(answer===undefined && profile?.reviewed && profile.facts_digest===productFactsDigest(product))
    return {status:'approved',reused:true,profile:profilePath(productFile),answers:profile.answers,next:'产品资料已核实，直接复用；只有新增或改变的事实需要补问。'};
  if(!session) {
    check(answer===undefined,'Start grill mode before submitting an answer');
    product.grill_mode=true;
    await save(productFile,product);
    const known=profile?.answers || {};
    for(const q of grillQuestions)if(typeof product.knowledge?.[q.id]==='string')known[q.id]={text:product.knowledge[q.id],source:'existing-product-information'};
    session={schema:'hypit.ecommerce.grill.v1',product_id:product.id,answers:known,reviewed:false};
    await save(file,session);
    await save(profilePath(productFile),{schema:'hypit.ecommerce.product-profile.v1',product_id:product.id,answers:session.answers,facts:product.facts || {},reviewed:false,facts_digest:productFactsDigest(product)});
  }
  check(session.product_id===product.id,'Grill session belongs to a different product');
  if(answer!==undefined) {
    const next=questionId ? grillQuestions.find(q=>q.id===questionId) : grillQuestions.find(q=>!session.answers[q.id]);
    check(next,'Unknown question or all questions already answered');
    check(typeof answer==='string' && answer.trim().length>=2,'Answer must be substantive');
    session.answers[next.id]={text:answer.trim(),at:new Date().toISOString()};
    session.reviewed=false;delete session.product_sha256;delete session.evidence;
    await save(file,session);
    await save(profilePath(productFile),{schema:'hypit.ecommerce.product-profile.v1',product_id:product.id,answers:session.answers,facts:product.facts || {},reviewed:false,facts_digest:productFactsDigest(product)});
  }
  return result(productFile,session);
}

export async function approveGrill(productFile,evidence) {
  check(typeof evidence==='string' && evidence.trim(),'Review evidence required');
  const product=await read(productFile), file=sessionPath(productFile), session=await read(file);
  check(product.grill_mode===true && session.product_id===product.id,'Grill mode is not active for this product');
  check(grillQuestions.every(q=>session.answers[q.id]?.text?.trim()),'Answer every grill question first');
  check(product.slots && Object.keys(product.slots).length,'Map reviewed selling points into product slots first');
  session.reviewed=true;session.evidence=evidence.trim();session.product_sha256=hash(await fs.readFile(productFile));session.facts_digest=productFactsDigest(product);
  session.reviewed_at=new Date().toISOString();
  await save(file,session);
  await save(profilePath(productFile),{...session,schema:'hypit.ecommerce.product-profile.v1',facts:product.facts || {},slots:product.slots});
  return {status:'approved',session:file,profile:profilePath(productFile),product:product.id};
}
