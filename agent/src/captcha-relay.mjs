// The Relay control panel the supplied CAPTCHA package expects on 127.0.0.1:8787 (vendor/captcha-solver
// README: "the control-panel endpoint the extension posts to"). It was not part of the package, so it
// is built here from the package's own calls:
//   POST /api/solve_captcha  {type:'audio', audio_b64}        -> {ok, text}       (captcha_solver.js, solver_ext)
//                            {type:'slider', bg, piece}        -> {ok, x_offset}   (captcha_solver.js, solver_ext)
//                            {type:'vlm_grid', image_b64, prompt} -> {ok, tiles} | {ok:false, error}
//   POST /api/hidden_captcha {img, box, instruction, tiles, canvas} -> hidden_captcha.js's own stdout
//   GET  /health
// Audio is transcribed locally (whisper.cpp; the package's own faster-whisper already ran first), never
// sent to Google. A vision refusal comes back as the model's words in `error`, which the package records
// as a decline and stops on. Only CAPTCHA vendor frames and extensions may call it from a browser.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {transcribe} from './captcha-audio.mjs';
import {callService} from './captcha-service.mjs';
import {visionJson} from './captcha-vision.mjs';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
const VENDOR_DIR=join(ROOT,'vendor','captcha-solver');
export const RELAY_PORT=Number(process.env.RELAY_PORT||8787);
const MAX_BODY=16*1024*1024;
const VENDOR_ORIGIN=/^https:\/\/([a-z0-9-]+\.)*(google\.com|recaptcha\.net|hcaptcha\.com|challenges\.cloudflare\.com)$/i;

// Which browser origins may call which route. Server-side callers (the package in Node) send no Origin.
// The ByteDance slider branch of solver_ext runs in any page frame, so `slider` (local OpenCV only) is
// open to every origin; audio and vision spend local compute or his CLI quota and stay vendor-only.
export function originAllowed(origin,{route,type}={}){
 if(!origin)return true;
 if(/^chrome-extension:\/\//.test(origin))return true;
 if(route==='/api/hidden_captcha')return false;
 if(VENDOR_ORIGIN.test(origin))return true;
 return route==='/api/solve_captcha'&&type==='slider';
}

export async function solveCaptcha(body,{transcribeImpl=transcribe,service=callService,vision=visionJson}={}){
 const type=body?.type;
 if(type==='audio'){
  if(!body.audio_b64)return {ok:false,error:'audio_b64 missing'};
  try{const text=await transcribeImpl(Buffer.from(body.audio_b64,'base64'));return text?{ok:true,text,engine:'whisper.cpp'}:{ok:false,error:'empty transcript'};}
  catch(e){return {ok:false,error:'transcription failed: '+String(e?.message??e).slice(0,120)};}
 }
 if(type==='slider'){
  if(!body.bg||!body.piece)return {ok:false,error:'bg and piece required'};
  const s=await service('/slide',{bg:body.bg,piece:body.piece},{timeoutMs:30000}).catch(e=>({ok:false,error:String(e?.message??e)}));
  return s.ok&&typeof s.x==='number'?{ok:true,x_offset:s.x,confidence:s.conf,method:s.method}:{ok:false,error:s.error||'no slot found'};
 }
 if(type==='vlm_grid'){
  if(!body.image_b64||!body.prompt)return {ok:false,error:'image_b64 and prompt required'};
  const r=await vision(Buffer.from(body.image_b64,'base64'),String(body.prompt));
  if(r.declined)return {ok:false,declined:true,error:String(r.text||'the vision model declined').slice(0,300)};
  const j=r.json;const tiles=Array.isArray(j)?j:(j?.tiles||j?.numbers);
  return Array.isArray(tiles)?{ok:true,tiles,by:'claude-cli'}:{ok:false,error:r.error||'no tiles in the reply'};
 }
 return {ok:false,error:`unknown type ${JSON.stringify(type)}`};
}

// hidden_captcha.js reads one JSON object on stdin and writes one line of JSON.
export function runHiddenCaptcha(body,{script=join(VENDOR_DIR,'hidden_captcha.js'),timeoutMs=180000,spawnImpl=spawn}={}){
 return new Promise(resolve=>{
  // CAPTCHA_DEBUG makes the package log "vision declined: ..." on stderr; its stdout says only "no tiles".
  const p=spawnImpl(process.execPath,[script],{cwd:VENDOR_DIR,stdio:['pipe','pipe','pipe'],env:{...process.env,CAPTCHA_DEBUG:'1'}});
  let out='',err='';const t=setTimeout(()=>{try{p.kill('SIGKILL');}catch{}},timeoutMs);
  p.stdout.on('data',d=>{out+=d;});p.stderr?.on('data',d=>{err+=d;});
  p.on('error',e=>{clearTimeout(t);resolve({ok:false,error:e.message});});
  p.on('close',()=>{
   clearTimeout(t);
   let r;try{r=JSON.parse(out.trim().split('\n').pop());}catch{r={ok:false,error:'hidden_captcha.js gave no JSON'};}
   const declined=String(err).match(/vision declined:\s*(.*)/);
   resolve(!r.ok&&declined?{...r,declined:true,error:'the vision model declined: '+declined[1].slice(0,200)}:r);
  });
  p.stdin.end(JSON.stringify(body));
 });
}

const readBody=req=>new Promise((resolve,reject)=>{
 let size=0;const parts=[];
 req.on('data',c=>{size+=c.length;if(size>MAX_BODY){reject(new Error('body too large'));req.destroy();}else parts.push(c);});
 req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8')||'{}'));}catch{reject(new Error('invalid JSON'));}});
 req.on('error',reject);
});

export function createRelay({solve=solveCaptcha,hidden=runHiddenCaptcha,log=()=>{}}={}){
 return createServer(async(req,res)=>{
  const origin=req.headers.origin;const route=req.url.split('?')[0];
  const send=(code,obj,{cors=false}={})=>{
   const headers={'Content-Type':'application/json'};
   if(cors&&origin)Object.assign(headers,{'Access-Control-Allow-Origin':origin,'Vary':'Origin'});
   res.writeHead(code,headers);res.end(JSON.stringify(obj));
  };
  if(req.method==='OPTIONS'){
   // Chrome's private-network preflight: a public page frame reaching 127.0.0.1.
   if(!origin||!(VENDOR_ORIGIN.test(origin)||/^chrome-extension:/.test(origin)||route==='/api/solve_captcha')){res.writeHead(403);return res.end();}
   res.writeHead(204,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type',
    'Access-Control-Allow-Private-Network':'true','Vary':'Origin'});return res.end();
  }
  if(req.method==='GET'&&route==='/health')return send(200,{ok:true,pid:process.pid});
  if(req.method!=='POST'||!['/api/solve_captcha','/api/hidden_captcha'].includes(route))return send(404,{ok:false,error:'not found'});
  let body;try{body=await readBody(req);}catch(e){return send(400,{ok:false,error:e.message});}
  if(!originAllowed(origin,{route,type:body?.type}))return send(403,{ok:false,error:'origin not allowed'});
  const started=Date.now();
  const out=route==='/api/hidden_captcha'?await hidden(body):await solve(body);
  log(`${route} ${body?.type||body?.instruction?.slice?.(0,40)||''} -> ${out.ok?'ok':'fail'} ${Date.now()-started}ms${out.error?' '+String(out.error).slice(0,80):''}`);
  send(200,out,{cors:true});
 });
}

// Started on first use, detached, like the package's model service (captcha_solver.js ensureSvc).
export async function relayUp(fetchImpl=fetch){
 try{const r=await fetchImpl(`http://127.0.0.1:${RELAY_PORT}/health`,{signal:AbortSignal.timeout(1500)});return r.ok&&(await r.json()).ok===true;}catch{return false;}
}
let starting=null;
export async function ensureRelay({spawnImpl=spawn,tries=20,waitMs=500}={}){
 if(await relayUp())return true;
 starting??=(async()=>{
  spawnImpl(process.execPath,[join(ROOT,'tools','captcha-relay.mjs')],{detached:true,stdio:'ignore'}).unref();
  for(let i=0;i<tries;i++){await new Promise(r=>setTimeout(r,waitMs));if(await relayUp())return true;}
  return false;
 })().finally(()=>{starting=null;});
 return starting;
}
