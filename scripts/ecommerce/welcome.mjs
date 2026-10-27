import path from 'node:path';
import fs from 'node:fs/promises';
import {createInterface} from 'node:readline/promises';
import {check,read,save,withLock} from './core.mjs';
import {generationChoice,loadSettings,grillReminder} from './settings.mjs';

const stateFile=root=>path.join(root,'.ecommerce-onboarding.json');
const choices=(values,labels)=>values.map((value,i)=>({value,label:labels[i]}));
function steps(answers) {
  const result=[
    {id:'image',title:'生图方式',question:'生成商品首帧时，使用哪种方式？',detail:'API：Comfly Nano Banana 2.1，默认4K。原生：使用当前Agent实际可用的生图工具，记录实际尺寸。',options:choices(['api','native'],['API 生图','Agent 原生生图'])},
    {id:'video',title:'生视频方式',question:'生成视频时，使用哪种方式？',detail:'API：APIMart Grok 基础版，默认720p、9:16。原生：需要当前Agent确实具备生视频能力。',options:choices(['api','native'],['API 生视频','Agent 原生生视频'])},
  ];
  if(answers.image==='api'||answers.video==='api')result.push({id:'fallback',title:'失败处理',question:'API 明确失败后，是否允许用实际可用的原生能力兜底？',detail:'结果未知的API请求仍须先核对，不会直接重复生成。',options:choices(['none','native'],['保留失败记录，不自动切换','允许原生兜底（能力存在时）'])});
  result.push(
    {id:'intake',title:'产品卖点',question:'新产品默认怎样准备卖点？',detail:grillReminder,options:choices(['grill','provided'],['开启拷问模式，先聊透卖点','直接使用我提供的产品资料'])},
    {id:'quality',title:'视觉检查',question:'默认开启模型视觉检查吗？',detail:'检查商品保持、穿模和场景连续性。关闭可提高速度；无人值守开启检查时需要接好真实视觉接口。',options:choices(['on','off'],['开启检查','关闭检查，优先速度'])},
    {id:'music',title:'音乐库',question:'填写音乐库文件夹路径，或输入“稍后”跳过。',detail:'你自行筛选和预处理音频，程序每次随机选一首。纯配乐模板在开始生产前仍需要音乐。',input:'folder',can_skip:true},
    {id:'workflow',title:'默认流程',question:'平时默认使用哪种生产流程？',detail:'逐步审核会先预览首帧。无人值守在任务资料、能力接口和整批授权齐备后自动生产；本次引导不会提交生成。',options:choices(['guided','unattended'],['逐步审核','批量无人值守'])},
  );return result;
}
async function initialState(root) {
  const settings=await loadSettings(root),p=settings?.preferences || {},generation=settings?.generation,answers={};
  if(generation) {
    const known=generationChoice(generation);answers.image=known.image;answers.video=known.video;
    const apiKinds=['image','video'].filter(kind=>known[kind]==='api');
    if(apiKinds.length&&apiKinds.every(kind=>known.fallback[kind]===known.fallback[apiKinds[0]]))answers.fallback=known.fallback[apiKinds[0]]?'native':'none';
    else if(apiKinds.length)answers.fallback=known.fallback;
  }
  if(['grill','provided'].includes(p.product_intake))answers.intake=p.product_intake;
  if(typeof p.visual_check==='boolean')answers.quality=p.visual_check?'on':'off';
  if(Object.hasOwn(p,'music_library'))answers.music=p.music_library?.path || null;
  if(['guided','unattended'].includes(p.workflow))answers.workflow=p.workflow;
  return {schema:'hypit.ecommerce.onboarding.v1',answers,started_at:new Date().toISOString(),completed:settings?.onboarding_completed===true};
}
async function stateAt(root) {
  const state=await read(stateFile(root)).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  return state?.completed?initialState(root):(state || initialState(root));
}
function summary(a) {
  return {生图:a.image==='api'?'API · Nano Banana 2.1 · 4K':a.image==='native'?'Agent原生生图':'未选择',
    生视频:a.video==='api'?'API · Grok · 720p · 9:16':a.video==='native'?'Agent原生生视频':'未选择',
    API失败兜底:a.image!=='api'&&a.video!=='api'?'不适用':typeof a.fallback==='object'?`生图${a.fallback.image?'允许':'不允许'}、生视频${a.fallback.video?'允许':'不允许'}`:a.fallback==='native'?'允许实际可用的原生能力':'不自动切换',
    产品卖点:a.intake==='grill'?'优先拷问，复用已有档案':a.intake==='provided'?'使用现有资料':'未选择',
    视觉检查:a.quality==='on'?'开启':a.quality==='off'?'关闭':'未选择',音乐库:a.music || '暂不设置',
    默认流程:a.workflow==='unattended'?'批量无人值守':a.workflow==='guided'?'逐步审核':'未选择'};
}
async function view(root,state) {
  const list=steps(state.answers),next=list.find(step=>!Object.hasOwn(state.answers,step.id)),settings=await loadSettings(root);
  if(!next&&state.completed)return {status:'ready',title:'首次使用引导已完成',summary:summary(state.answers),settings:path.join(root,'ecommerce-settings.json'),
    next:'把产品文件夹和想用的模板告诉Agent即可；它会复用设置和已有资料。单次任务可覆盖默认值。',
    agent_preferences:{product_intake:state.answers.intake,workflow:state.answers.workflow},
    edit:'welcome-answer <workspace> <step-id> <新答案> 可修改；welcome <workspace> --edit 可重新逐项设置。',paid_generation_calls:0};
  const question=next || {id:'confirm',title:'确认设置',question:'保存以上设置并完成引导吗？',detail:'只保存偏好，不代表付费生产授权。',options:choices(['save','later'],['保存并完成','暂不保存，稍后继续'])};
  const notes=[];
  if(settings?.generation&&!state.completed)notes.push('已复用之前明确选择的生成方式，只补齐缺失设置。');
  if(state.answers.music) {
    const directory=await fs.stat(state.answers.music).catch(()=>null);
    if(!directory?.isDirectory())notes.push('音乐库目前不可访问；可稍后修改，生产前会再检查。');
  }
  return {status:next?'question':'confirm',title:'欢迎使用电商版 Hypit',progress:{current:next?list.indexOf(next)+1:list.length+1,total:list.length+1},
    question,summary:summary(state.answers),notes,
    instruction:'向用户一次只展示当前问题，记录真实回答后调用 welcome-answer；不要代替用户选择，也不要索取或回显token。',
    command:`welcome-answer <workspace> ${question.id} "用户回答"`,paid_generation_calls:0};
}
export async function welcome(root=process.cwd(),{edit=false}={}) {
  root=path.resolve(root);await fs.mkdir(root,{recursive:true});
  return withLock(root,async()=>{
    const state=edit?{schema:'hypit.ecommerce.onboarding.v1',answers:{},started_at:new Date().toISOString(),completed:false}:await stateAt(root);
    await save(stateFile(root),state);return view(root,state);
  });
}
function optionAnswer(step,text) {
  const aliases={api:['api','接口','api生图','api生视频'],native:['native','原生','原生能力','原生生图','原生生视频','允许','允许兜底'],none:['none','不允许','不兜底','否'],grill:['grill','拷问','开启拷问模式','开启','是'],provided:['provided','现有资料','直接使用资料','否'],on:['on','开启','是'],off:['off','关闭','否'],guided:['guided','逐步审核','手动'],unattended:['unattended','无人值守','全自动'],save:['save','保存','确认','是'],later:['later','稍后','暂不保存','否']};
  const value=text.trim().toLowerCase(),selected=step.options.find((option,i)=>value===String(i+1)||value===option.label.toLowerCase()||(aliases[option.value] || []).includes(value));
  check(selected,'答案无法识别，请选择当前列出的选项编号或名称');return selected.value;
}
export async function answerWelcome(root,id,text) {
  root=path.resolve(root);check(typeof text==='string','请提供本题答案');
  return withLock(root,async()=>{
    const state=await stateAt(root),step=steps(state.answers).find(x=>x.id===id);
    if(id==='confirm') {
      check(steps(state.answers).every(x=>Object.hasOwn(state.answers,x.id)),'请先完成引导问题');
      const decision=optionAnswer({options:choices(['save','later'],['保存并完成','暂不保存，稍后继续'])},text);
      if(decision==='later')return {...await view(root,state),status:'paused'};
      const a=state.answers,previous=await loadSettings(root) || {},generation=generationChoice({image:a.image,video:a.video,
        fallback:{image:a.image==='api'&&(typeof a.fallback==='object'?a.fallback.image:a.fallback==='native'),video:a.video==='api'&&(typeof a.fallback==='object'?a.fallback.video:a.fallback==='native')},
        evidence:'用户通过首次使用引导逐项选择并确认保存'});
      await save(path.join(root,'ecommerce-settings.json'),{...previous,schema:'hypit.ecommerce.settings.v1',generation,
        grill_reminder_acknowledged:true,onboarding_completed:true,preferences:{...previous.preferences,product_intake:a.intake,visual_check:a.quality==='on',music_library:a.music?{path:a.music,gain:0.18}:null,workflow:a.workflow},at:new Date().toISOString()});
      state.completed=true;
    } else {
      check(step,'未知或当前不适用的引导步骤');
      if(step.input==='folder') {
        const value=text.trim().replace(/^"(.*)"$/,'$1');
        check(!/[\r\n\x00]/.test(value),'音乐库路径无效');
        state.answers[id]=['','稍后','跳过','skip','later'].includes(value.toLowerCase())?null:path.resolve(root,value);
        if(state.answers[id])check((await fs.stat(state.answers[id]).catch(()=>null))?.isDirectory(),'该音乐库文件夹不存在，请输入已有目录，或输入“稍后”');
      } else state.answers[id]=optionAnswer(step,text);
      if(['image','video'].includes(id)&&state.answers.image!=='api'&&state.answers.video!=='api')delete state.answers.fallback;
      state.completed=false;
    }
    state.updated_at=new Date().toISOString();await save(stateFile(root),state);return view(root,state);
  });
}
export async function interactiveWelcome(root=process.cwd(),options={}) {
  if(!process.stdin.isTTY||!process.stdout.isTTY)return {...await welcome(root,options),note:'当前不是交互终端，请由Agent逐题展示和记录；也可在终端运行 welcome --interactive。'};
  const rl=createInterface({input:process.stdin,output:process.stdout}),controller=new AbortController();let paused=false;
  rl.on('SIGINT',()=>{paused=true;controller.abort();rl.close();});
  try {
    let current=await welcome(root,options);const alreadyReady=current.status==='ready';
    process.stdout.write('\n电商版 Hypit · 首次使用引导\n');
    if(alreadyReady){process.stdout.write('已加载保存的设置：\n');for(const [key,value] of Object.entries(current.summary))process.stdout.write(`${key}：${value}\n`);}
    else process.stdout.write('本引导只保存设置，不提交付费生成；随时 Ctrl+C 暂停。\n');
    while(['question','confirm'].includes(current.status)) {
      const q=current.question;process.stdout.write(`\n[${current.progress.current}/${current.progress.total}] ${q.title}\n${q.question}\n${q.detail}\n`);
      if(q.id==='confirm')for(const [key,value] of Object.entries(current.summary))process.stdout.write(`${key}：${value}\n`);
      for(const [i,option] of (q.options || []).entries())process.stdout.write(`${i+1}. ${option.label}\n`);
      const answer=await rl.question('> ',{signal:controller.signal});
      try{current=await answerWelcome(root,q.id,answer);}catch(error){process.stdout.write(error.message+'\n');}
    }
    if(current.status==='ready')process.stdout.write(alreadyReady?'\n把产品文件夹和模板告诉Agent即可开始。\n':'\n设置已保存。把产品文件夹和模板告诉Agent即可开始。\n');
    if(current.status==='paused')process.stdout.write('\n已保留草稿，下次启动继续；当前设置保持不变。\n');
    return current;
  }catch(error){if(paused||error.code==='ERR_USE_AFTER_CLOSE'){process.stdout.write('\n已保留回答，下次启动继续。\n');return {status:'paused',note:'已保留回答，下次启动继续。',paid_generation_calls:0};}throw error;}
  finally{rl.close();}
}
