// Client for the local CAPTCHA model service (tools/captcha-service.py): ddddocr OCR and slider
// matching, a YOLO reCAPTCHA tile classifier, faster-whisper audio. Started on first use, detached,
// from the venv tools/setup-captcha-models.sh creates; every caller falls back to other tiers when
// the service is unavailable. CAPTCHA_LOCAL_MODELS=0 disables it (tests, machines without the venv).
import {spawn} from 'node:child_process';
import {existsSync,openSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
export const serviceUrl=()=>'http://127.0.0.1:'+(process.env.CAPTCHA_SERVICE_PORT||8796);
export const servicePython=()=>join(ROOT,'private/captcha-env/bin/python');
export const serviceScript=()=>join(ROOT,'tools/captcha-service.py');
export const localModelsDisabled=(env=process.env)=>env.CAPTCHA_LOCAL_MODELS==='0';

export async function serviceUp(fetchImpl=fetch){
 try{const r=await fetchImpl(serviceUrl()+'/health',{signal:AbortSignal.timeout(1500)});return r.ok&&(await r.json()).ok===true;}catch{return false;}
}

let starting=null;
export async function ensureService({fetchImpl=fetch,spawnImpl=spawn,waitMs=1000,tries=40,python=servicePython(),log=()=>{}}={}){
 if(localModelsDisabled())return false;
 if(await serviceUp(fetchImpl))return true;
 if(!starting)starting=(async()=>{
  if(!existsSync(python))return false;
  mkdirSync(join(ROOT,'state'),{recursive:true});
  const out=openSync(join(ROOT,'state/captcha-service.log'),'a');
  try{spawnImpl(python,[serviceScript()],{detached:true,stdio:['ignore',out,out]}).unref();}catch(e){await log(`CAPTCHA model service failed to start: ${e.message}`);return false;}
  for(let i=0;i<tries;i++){await new Promise(r=>setTimeout(r,waitMs));if(await serviceUp(fetchImpl))return true;}
  return false;
 })().finally(()=>{starting=null;});
 return starting;
}

// POST a route; {ok:false,error} on any failure so callers can continue with the next tier.
export async function callService(route,body,{timeoutMs=120000,fetchImpl=fetch,ensure=ensureService}={}){
 if(localModelsDisabled())return {ok:false,error:'local models disabled (CAPTCHA_LOCAL_MODELS=0)'};
 if(!(await ensure({fetchImpl})))return {ok:false,error:'local model service unavailable (run tools/setup-captcha-models.sh)'};
 try{
  const r=await fetchImpl(serviceUrl()+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
  return await r.json();
 }catch(e){return {ok:false,error:'service: '+String(e?.message??e).slice(0,100)};}
}
