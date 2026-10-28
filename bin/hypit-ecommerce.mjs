#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {review,assemble} from '../scripts/ecommerce/assembly.mjs';
import {setup,setRunGeneration} from '../scripts/ecommerce/settings.mjs';
import {prepareMatrix,runMatrix,matrixStatus,preflightMatrix,authorizeMatrix} from '../scripts/ecommerce/matrix.mjs';
import {compile,createPlan,describeAdaptation,read,save,approve,withLock,check,fileAt} from '../scripts/ecommerce/core.mjs';
import {generateFrames,generateVideos} from '../scripts/ecommerce/providers.mjs';
import {grill,approveGrill,productInfo} from '../scripts/ecommerce/grill.mjs';
import {setQuality,inspect,recordQuality} from '../scripts/ecommerce/quality.mjs';
import {prepareRetry} from '../scripts/ecommerce/attempts.mjs';
import {importNative} from '../scripts/ecommerce/native.mjs';
import {alignCaptions} from '../scripts/ecommerce/finishing.mjs';
import {welcome,answerWelcome,interactiveWelcome} from '../scripts/ecommerce/welcome.mjs';
import {diagnostics,timed} from '../scripts/ecommerce/execution.mjs';

async function main() {
  const [cmd,...args]=process.argv.slice(2);
  if(!cmd){if(process.stdin.isTTY&&process.stdout.isTTY){await interactiveWelcome(process.cwd());return;}return welcome(process.cwd());}
  if(cmd==='--help')return {onboarding:await setup(process.cwd()),commands:{welcome:'welcome [workspace] [--interactive] [--edit]','welcome-answer':'welcome-answer workspace step-id "answer"',setup:'setup workspace [choices.json]',route:'route run-dir choices.json',matrix:'matrix batch-spec.json new-batch-dir','matrix-check':'matrix-check batch-dir','matrix-authorize':'matrix-authorize batch-dir \"actual upfront user authorization\"','matrix-run':'matrix-run batch-dir --submit','matrix-status':'matrix-status batch-dir',compile:'compile analysis.json reference.mp4 new-template-dir',adapt:'adapt template.json product.json',grill:'grill product.json', 'product-info':'product-info product.json [question-id]', 'grill-answer':'grill-answer product.json "answer" [question-id]', 'grill-approve':'grill-approve product.json "review evidence"',plan:'plan template.json product.json new-run-dir',batch:'batch template.json products-dir new-output-dir', 'batch-frames':'batch-frames batch-dir --submit', 'batch-approve':'batch-approve batch-dir "actual whole-batch approval evidence"', 'batch-videos':'batch-videos batch-dir --submit', 'batch-assemble':'batch-assemble batch-dir',frames:'frames run-dir --submit',review:'review run-dir',quality:'quality run-dir on|off',inspect:'inspect run-dir frames|videos [id1,id2]',diagnostics:'diagnostics run-dir','inspect-result':'inspect-result run-dir result.json',retry:'retry run-dir image|video id "reason"','native-import':'native-import run-dir image|video id file "actual native generation evidence"',align:'align run-dir edit.json',approve:'approve run-dir "actual human approval evidence"',videos:'videos run-dir --submit',assemble:'assemble run-dir reviewed-edit.json',status:'status run-dir'}};
  if(cmd==='welcome'){
    const result=await (args.includes('--interactive')?interactiveWelcome:welcome)(args.find(arg=>!arg.startsWith('--')) || process.cwd(),{edit:args.includes('--edit')});
    return args.includes('--interactive')&&process.stdin.isTTY&&process.stdout.isTTY?undefined:result;
  }
  if(cmd==='welcome-answer')return answerWelcome(args[0],args[1],args[2]);
  if(cmd==='setup')return setup(args[0],args[1]);
  if(cmd==='matrix')return prepareMatrix(args[0],args[1]);
  if(cmd==='matrix-status')return matrixStatus(args[0]);
  if(cmd==='matrix-check')return preflightMatrix(args[0]);
  if(cmd==='matrix-authorize')return authorizeMatrix(args[0],args[1]);
  if(cmd==='matrix-run'){check(args[1]==='--submit','Batch generation requires --submit and prior user authorization');return runMatrix(args[0]);}
  if(cmd==='compile')return compile(...args);
  if(cmd==='grill')return grill(args[0]);
  if(cmd==='grill-answer')return grill(args[0],args[1],args[2]);
  if(cmd==='grill-approve')return approveGrill(args[0],args[1]);
  if(cmd==='product-info')return productInfo(args[0],args[1]);
  if(cmd==='adapt')return describeAdaptation(args[0],args[1]);
  if(cmd==='plan')return {...await createPlan(...args),onboarding:await setup(process.cwd())};
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
  if(['batch-frames','batch-videos','batch-approve','batch-assemble'].includes(cmd)) {
    const manifest=await read(path.join(root,'batch.json'));
    if(['batch-frames','batch-videos'].includes(cmd))check(args[1]==='--submit','Paid generation requires --submit and user authorization');
    if(cmd==='batch-approve')check(args[1]?.trim(),'Human whole-batch approval evidence required');
    return withLock(root,async()=>{
      const results=[];
      for(const item of manifest) {
        if(item.status!=='planned'){results.push(item);continue;}
        const project=fileAt(root,item.product);
        try {
          const result=await withLock(project,async()=>{
            if(cmd==='batch-frames'){const r=await generateFrames(project);if(r)return r;await review(project);}
            if(cmd==='batch-approve')await approve(project,args[1]);
            if(cmd==='batch-videos')return generateVideos(project);
            if(cmd==='batch-assemble')return assemble(project,path.join(project,'edit.json'));
          });results.push({product:item.product,status:result?.status || 'complete',result});
        }catch(e){results.push({product:item.product,status:'failed',reason:e.message});}
        await save(path.join(root,cmd+'-results.json'),results);
      }
      return results;
    });
  }
  if(cmd==='review')return review(root);
  if(cmd==='status')return {plan:await read(path.join(root,'plan.json')),receipts:await fs.readdir(path.join(root,'receipts')).catch(()=>[])};
  return withLock(root,async()=>{
    if(cmd==='route')return setRunGeneration(root,args[1]);
    if(cmd==='quality')return setQuality(root,args[1]);
    if(cmd==='inspect')return timed(root,'inspect',args[1],()=>inspect(root,args[1],args[2]?.split(',')));
    if(cmd==='diagnostics')return diagnostics(root);
    if(cmd==='inspect-result')return recordQuality(root,args[1]);
    if(cmd==='retry')return prepareRetry(root,args[1],args[2],args[3]);
    if(cmd==='native-import')return importNative(root,args[1],args[2],args[3],args[4]);
    if(cmd==='align')return alignCaptions(root,args[1]);
    if(cmd==='approve'){await approve(root,args[1]);return {approved:true};}
    if(cmd==='frames'||cmd==='videos') {
      check(args[1]==='--submit','Paid generation requires --submit and user authorization');
      if(cmd==='frames'){const r=await generateFrames(root);return r || review(root);}
      const r=await generateVideos(root);return r || {status:'clips ready for dialogue/timing review'};
    }
    if(cmd==='assemble')return timed(root,'assemble','final',()=>assemble(root,args[1]));
    throw new Error('Unknown command');
  });
}
try {const result=await main();if(result!==undefined)console.log(JSON.stringify(result,null,2));}catch(e){console.error(JSON.stringify({error:e.message}));process.exitCode=1;}
