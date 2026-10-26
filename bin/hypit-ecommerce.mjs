#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {compile,createPlan,read,save,approve,withLock,check,media,fileAt,verifyApproval} from '../scripts/ecommerce/core.mjs';
import {generateFrames,generateVideos} from '../scripts/ecommerce/providers.mjs';
import {grill,approveGrill} from '../scripts/ecommerce/grill.mjs';

const escape = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const musicExtensions = new Set(['.mp3','.wav','.m4a','.aac','.flac','.ogg','.opus']);
async function musicForAssembly(root, edit, editFile) {
  check(!(edit.music && edit.music_library), 'Choose either music or music_library');
  if(edit.music) {
    check(edit.music.reviewed_music_only===true,'Original mixed audio cannot be treated as music');
    const gain=edit.music.gain ?? 0.15;check(Number.isFinite(gain)&&gain>=0&&gain<=1,'Invalid music gain');
    return {file:fileAt(root,edit.music.path),gain,source:'single-track'};
  }
  const config=edit.music_library || (process.env.HYPIT_ECOMMERCE_MUSIC_LIBRARY ? {path:process.env.HYPIT_ECOMMERCE_MUSIC_LIBRARY} : null);
  if(!config)return null;
  check(typeof config.path==='string' && config.path.trim(),'Music library path required');
  const gain=config.gain ?? 0.18;check(Number.isFinite(gain)&&gain>=0&&gain<=1,'Invalid music gain');
  const folder=path.resolve(path.dirname(path.resolve(editFile)),config.path);
  check((await fs.stat(folder).catch(()=>null))?.isDirectory(),`Music library folder missing: ${folder}`);
  const receiptFile=path.join(root,'assembly','music-selection.json');
  const previous=await read(receiptFile).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(previous) {
    check(previous.library===folder,'Music library changed for this run; use a new run for a new selection');
    const copy=fileAt(root,previous.copy);
    check((await fs.stat(copy).catch(()=>null))?.isFile(),'Selected music copy missing');
    check(crypto.createHash('sha256').update(await fs.readFile(copy)).digest('hex')===previous.sha256,'Selected music copy changed');
    return {file:copy,gain,source:'library',selection:previous};
  }
  const entries=(await fs.readdir(folder,{withFileTypes:true}))
    .filter(entry=>entry.isFile() && musicExtensions.has(path.extname(entry.name).toLowerCase()))
    .map(entry=>entry.name).sort();
  check(entries.length>0,`Music library has no supported audio files: ${folder}`);
  const chosen=entries[crypto.randomInt(entries.length)];
  const source=path.join(folder,chosen), copyRelative=`assembly/selected-music${path.extname(chosen).toLowerCase()}`;
  const copy=fileAt(root,copyRelative);
  await fs.copyFile(source,copy);
  const selection={library:folder,chosen,copy:copyRelative,sha256:crypto.createHash('sha256').update(await fs.readFile(copy)).digest('hex'),selected_at:new Date().toISOString()};
  await save(receiptFile,selection);
  return {file:copy,gain,source:'library',selection};
}
async function review(root) {
  const p=await read(path.join(root,'plan.json'));
  const cards=(await Promise.all(p.frames.map(async f=>{
    const available=await fs.stat(path.join(root,'frames',f.id+'.png')).then(()=>true).catch(()=>false);
    const receipt=await read(path.join(root,'receipts','image-'+f.id+'.json')).catch(()=>null);
    const visual=available?`<a href="frames/${f.id}.png"><img src="frames/${f.id}.png"></a>`:`<p>未完成：${escape(receipt?.reason || receipt?.status || '尚未提交')}</p>`;
    return `<article><h2>${escape(f.id)}</h2>${visual}<details><summary>生图提示词</summary><p>${escape(f.prompt)}</p></details></article>`;
  }))).join('');
  const shots=p.shots.map(s=>`<li><b>${s.start}–${s.end} 秒 · ${escape(s.speaker)}</b><p>${escape(s.dialogue)}</p><p>${escape(s.prompt)}</p></li>`).join('');
  await fs.writeFile(path.join(root,'review.html'),`<!doctype html><meta charset="utf-8"><title>母女模板首帧审核</title><style>body{font:17px system-ui;max-width:1300px;margin:30px auto;background:#f4f2ed;color:#252525;padding:20px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}article{background:white;padding:16px}img{width:100%}p{line-height:1.6}li{margin:24px 0}</style><h1>基础版 · 首帧与商品适配审核</h1><p>视频尚未提交。检查女儿身份、开衫细节、上半身取景、母亲与背景连续性。图片通过后再生成视频。</p><div class="grid">${cards}</div><h2>对白与镜头</h2><p>原片转写有疑似错词；商品相关句子已替换为可见外观，尚未确认的功能卖点未沿用。</p><ol>${shots}</ol><p>Grok 使用图片参考，不支持本路线的视频参考。音色与精确对白节奏需要生成后审核。音乐尚未从原片分离。</p>`);
  return {review:path.resolve(root,'review.html')};
}
async function assemble(root, editFile) {
  await verifyApproval(root);
  const p=await read(path.join(root,'plan.json')), edit=await read(editFile);
  check(edit.reviewed===true && edit.evidence,'Reviewed video trims and human evidence required');
  check(edit.shots?.length===p.shots.length,'Every shot must have a reviewed trim');
  await fs.mkdir(path.join(root,'assembly'),{recursive:true});
  const inputs=[];
  for(let i=0;i<p.shots.length;i++) {
    const s=p.shots[i], e=edit.shots[i];check(e.id===s.id && Number.isFinite(e.start) && e.start>=0,'Invalid trim');
    check(e.start+s.target_duration<=s.generation_duration+.05,'Trim exceeds generated duration');
    check(e.dialogue_complete===true,'Review complete spoken dialogue before cutting');
    const output=path.join(root,'assembly',`${i}.mp4`);
    media(['-y','-ss',String(e.start),'-i',fileAt(root,`clips/${s.id}.mp4`),'-t',String(s.target_duration),'-vf','scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-ar','48000','-ac','2',output]);inputs.push(`file '${i}.mp4'`);
  }
  await fs.writeFile(path.join(root,'assembly','concat.txt'),inputs.join('\n'));
  media(['-y','-f','concat','-safe','0','-i',path.join(root,'assembly','concat.txt'),'-c','copy',path.join(root,'assembly','dialogue.mp4')]);
  const music=await musicForAssembly(root,edit,editFile);
  if(music) {
    const musicEnd=p.shots.reduce((seconds,shot)=>seconds+shot.target_duration,0);
    media(['-y','-i',path.join(root,'assembly','dialogue.mp4'),'-stream_loop','-1','-i',music.file,'-filter_complex',`[1:a]volume=${music.gain},afade=t=in:st=0:d=0.25,afade=t=out:st=${Math.max(0,musicEnd-0.6)}:d=0.6[m];[0:a][m]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]`,'-map','0:v','-map','[a]','-c:v','copy','-c:a','aac','-shortest',path.join(root,'final.mp4')]);
  } else await fs.copyFile(path.join(root,'assembly','dialogue.mp4'),path.join(root,'final.mp4'));
  return {output:path.resolve(root,'final.mp4'),music:music ? {source:music.source,chosen:music.selection?.chosen || edit.music.path} : null};
}
async function main() {
  const [cmd,...args]=process.argv.slice(2);
  if(!cmd || cmd==='--help')return {commands:{compile:'compile analysis.json reference.mp4 new-template-dir',grill:'grill product.json', 'grill-answer':'grill-answer product.json "answer to current question"', 'grill-approve':'grill-approve product.json "review evidence"',plan:'plan template.json product.json new-run-dir',batch:'batch template.json products-dir new-output-dir', 'batch-frames':'batch-frames batch-dir --submit', 'batch-approve':'batch-approve batch-dir "actual whole-batch approval evidence"', 'batch-videos':'batch-videos batch-dir --submit',frames:'frames run-dir --submit',review:'review run-dir',approve:'approve run-dir "actual human approval evidence"',videos:'videos run-dir --submit',assemble:'assemble run-dir reviewed-edit.json',status:'status run-dir'}};
  if(cmd==='compile')return compile(...args);
  if(cmd==='grill')return grill(args[0]);
  if(cmd==='grill-answer')return grill(args[0],args[1],args[2]);
  if(cmd==='grill-approve')return approveGrill(args[0],args[1]);
  if(cmd==='plan')return createPlan(...args);
  if(cmd==='batch') {
    const [template,products,output]=args;await fs.mkdir(output,{recursive:false});const results=[];
    for(const item of (await fs.readdir(products,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(!item.isDirectory())continue;
      try {await createPlan(template,path.join(products,item.name,'product.json'),path.join(output,item.name));results.push({product:item.name,status:'planned'});}
      catch(e){results.push({product:item.name,status:'failed',reason:e.message});}
    }
    await save(path.join(output,'batch.json'),results);return results;
  }
  const root=args[0];check(root,'Run directory required');
  if(['batch-frames','batch-videos','batch-approve'].includes(cmd)) {
    const manifest=await read(path.join(root,'batch.json'));
    if(cmd!=='batch-approve')check(args[1]==='--submit','Paid generation requires --submit and user authorization');
    else check(args[1]?.trim(),'Human whole-batch approval evidence required');
    return withLock(root,async()=>{
      const results=[];
      for(const item of manifest) {
        if(item.status!=='planned'){results.push(item);continue;}
        const project=fileAt(root,item.product);
        try {
          await withLock(project,async()=>{
            if(cmd==='batch-frames'){await generateFrames(project);await review(project);}
            if(cmd==='batch-approve')await approve(project,args[1]);
            if(cmd==='batch-videos')await generateVideos(project);
          });results.push({product:item.product,status:'complete'});
        }catch(e){results.push({product:item.product,status:'failed',reason:e.message});}
        await save(path.join(root,cmd+'-results.json'),results);
      }
      return results;
    });
  }
  if(cmd==='review')return review(root);
  if(cmd==='status')return {plan:await read(path.join(root,'plan.json')),receipts:await fs.readdir(path.join(root,'receipts')).catch(()=>[])};
  return withLock(root,async()=>{
    if(cmd==='approve'){await approve(root,args[1]);return {approved:true};}
    if(cmd==='frames'||cmd==='videos') {
      check(args[1]==='--submit','Paid generation requires --submit and user authorization');
      if(cmd==='frames'){await generateFrames(root);return review(root);}
      await generateVideos(root);return {status:'clips ready for dialogue/timing review'};
    }
    if(cmd==='assemble')return assemble(root,args[1]);
    throw new Error('Unknown command');
  });
}
try {console.log(JSON.stringify(await main(),null,2));}catch(e){console.error(JSON.stringify({error:e.message}));process.exitCode=1;}
