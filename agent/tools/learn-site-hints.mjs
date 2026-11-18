// Learns site hints from one finished run, detached from its worker (finishSiteHints in
// src/dashboard-worker.mjs) so the worker exits at once. Usage: node tools/learn-site-hints.mjs RUN_DIR
import {readFile,unlink} from 'node:fs/promises';
import {resolve,join,basename} from 'node:path';
import {learnFromRun} from '../src/site-hints.mjs';
import {execCLI,atomic} from '../src/dashboard-worker.mjs';

const read=async(path,fallback)=>{try{return JSON.parse(await readFile(path,'utf8'));}catch{return fallback;}};
const runDir=resolve(process.argv[2]??'');
const payloadPath=join(runDir,'site-hints-run.json');
const payload=await read(payloadPath,null);
if(payload){
 await unlink(payloadPath).catch(()=>{});
 const state=await read(join(runDir,'state.json'),{});
 const request=await read(join(runDir,'request.json'),{});
 const profile=request.profilePath?await read(resolve(request.profilePath),{}):{};
 const notes=[];
 // The worker already scored the hints its steps saw; this only learns new ones.
 const result=await learnFromRun({state,used:{},steps:payload.steps,events:state.events??[],history:payload.history??[],
  engine:payload.engine,command:payload.command,model:payload.model,execImpl:execCLI,profile,runId:basename(runDir),log:m=>notes.push(m)});
 await atomic(join(runDir,'site-hints.json'),{at:new Date().toISOString(),added:result.added.map(h=>({id:h.id,text:h.text})),notes});
}
