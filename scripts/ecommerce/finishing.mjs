import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {check,read,save,fileAt,media} from './core.mjs';
import {probe} from './quality.mjs';

const time = (seconds,srt=false) => {const units=Math.round(seconds*(srt?1000:100)),scale=srt?1000:100;return `${String(Math.floor(units/(scale*3600))).padStart(srt?2:1,'0')}:${String(Math.floor(units/(scale*60))%60).padStart(2,'0')}:${String(Math.floor(units/scale)%60).padStart(2,'0')}${srt?',':'.'}${String(units%scale).padStart(srt?3:2,'0')}`;};
function parseSrt(text){return text.replace(/^\uFEFF/,'').trim().split(/\r?\n\s*\r?\n/).map(block=>{const lines=block.split(/\r?\n/),i=lines.findIndex(x=>x.includes('-->'));check(i>=0,'Invalid SRT cue');const parts=lines[i].split(/\s*-->\s*/);const seconds=s=>{const [h,m,rest]=s.trim().replace(',','.').split(':');return Number(h)*3600+Number(m)*60+Number(rest);};return {start:seconds(parts[0]),end:seconds(parts[1]),text:lines.slice(i+1).join('\n')};});}
export async function alignCaptions(root,editFile){
  root=path.resolve(root);const p=await read(path.join(root,'plan.json')),edit=await read(editFile);
  check(edit.shots?.length===p.shots.length,'Review all shot trims before alignment');
  const request={shots:p.shots.map((s,i)=>{const e=edit.shots[i];check(e.id===s.id&&e.dialogue_complete===true&&Number.isFinite(e.start)&&e.start>=0,'Review complete dialogue before alignment');const duration=e.duration ?? s.target_duration;check(Number.isFinite(duration)&&duration>0&&e.start+duration<=Number(probe(fileAt(root,`clips/${s.id}.mp4`)).format.duration)+.05,'Invalid alignment trim');return {id:s.id,file:fileAt(root,`clips/${s.id}.mp4`),start:e.start,duration,dialogue:s.dialogue};})};
  const folder=path.join(root,'alignment');await fs.mkdir(folder,{recursive:true});const input=path.join(folder,'request.json'),output=path.join(folder,'captions.json');await save(input,request);
  const script=new URL('./align.py',import.meta.url);
  const r=spawnSync(process.env.HYPIT_ECOMMERCE_PYTHON || (process.platform==='win32'?'py':'python3'),[decodeURIComponent(script.pathname).replace(/^\/([A-Za-z]:)/,'$1'),input,output],{encoding:'utf8',env:{...process.env,PYTHONIOENCODING:'utf-8'}});
  check(r.status===0,'Local ASR alignment failed; configure HYPIT_ECOMMERCE_PYTHON with faster-whisper installed: '+String(r.stderr || r.error?.message).slice(-900));
  return {status:'timings_need_review',captions:output,notes:'Review ASR against authored dialogue. Point edit.captions.path to alignment/captions.json and set reviewed after actual review.'};
}
export async function finishCaptions(root,edit,plan,input,output){
  const enabled=edit.captions===false ? false : (edit.captions?.enabled ?? plan.captions?.enabled ?? true);
  if(!enabled){await fs.copyFile(input,output);return {enabled:false};}
  const spec=edit.captions || {};check(spec.reviewed===true,'Caption timings need review; run align or supply reviewed SRT/cues, or explicitly disable captions');
  let cues=spec.cues;
  if(spec.path){const file=fileAt(root,spec.path);cues=path.extname(file).toLowerCase()==='.srt'?parseSrt(await fs.readFile(file,'utf8')):(await read(file)).cues;}
  check(Array.isArray(cues)&&cues.length,'Reviewed caption cues required');
  const duration=Number(probe(input).format.duration);let previous=0;
  for(const cue of cues){check(Number.isFinite(cue.start)&&Number.isFinite(cue.end)&&cue.start>=previous-0.01&&cue.end>cue.start&&cue.end<=duration+0.12&&typeof cue.text==='string'&&cue.text.trim(),'Invalid/overlapping caption cue');previous=cue.end;}
  const safe={left:42,right:145,bottom:315,...plan.captions?.safe_area,...spec.safe_area},size=spec.font_size || plan.captions?.font_size || 38;
  check(Object.values(safe).every(x=>Number.isFinite(x)&&x>=0)&&safe.left+safe.right<=500&&safe.bottom<1000&&Number.isFinite(size)&&size>=16&&size<=72,'Invalid caption safe area/font size');
  const srt=cues.map((c,i)=>`${i+1}\n${time(c.start,true)} --> ${time(c.end,true)}\n${c.text}\n`).join('\n');await fs.writeFile(path.join(root,'subtitles.srt'),srt,'utf8');
  const header=`[Script Info]\nScriptType: v4.00+\nPlayResX: 720\nPlayResY: 1280\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Dialogue,Microsoft YaHei,${size},&H00FFFFFF,&H00FFFFFF,&H00202020,&H50000000,-1,0,0,0,100,100,0,0,1,3,1,2,${safe.left},${safe.right},${safe.bottom},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const escape=text=>text.replace(/\\/g,'\\\\').replace(/{/g,'\\{').replace(/}/g,'\\}').replace(/\r?\n/g,'\\N');
  await fs.writeFile(path.join(root,'assembly','captions.ass'),header+cues.map(c=>`Dialogue: 0,${time(c.start)},${time(c.end)},Dialogue,,0,0,0,,${escape(c.text)}\n`).join(''),'utf8');
  media(['-y','-i',path.resolve(input),'-vf','ass=captions.ass','-c:v','libx264','-crf','18','-preset','medium','-pix_fmt','yuv420p','-c:a','copy','-movflags','+faststart',path.resolve(output)],{cwd:path.resolve(root,'assembly')});
  return {enabled:true,cues:cues.length,safe_area:safe,font_size:size,subtitles:'subtitles.srt'};
}
