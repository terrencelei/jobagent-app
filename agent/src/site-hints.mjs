// Learned site hints (idea after AutoApply's domain skills, 2026-10-29). Every ATS lesson so far
// became code in dashboard-worker.mjs through a repair agent. Cheaper step models (Haiku, the free
// OpenCode models) do better with a few notes about the site in front of them, so after a run a model
// writes down durable, non-personal knowledge about that site (where a control hides, a wait, a trap);
// the next runs on the site see the best of them as `siteHints` in the step input. Each hint gains a
// point when a run that saw it submits and loses one when such a run fails; at -3 it is retired.
// Hints only steer the step model: every worker guard and validator is unchanged.
import {readFile,writeFile,rename,mkdir,mkdtemp,rm,unlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {HIRING_PLATFORMS} from './accounts.mjs';
import {acquireLock} from './worker-lock.mjs';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
// Test processes never touch his live hints unless a test names a file.
export const HINTS_PATH=process.env.SITE_HINTS_PATH||(process.env.NODE_TEST_CONTEXT?null:join(ROOT,'state','site-hints.json'));
export const RETIRE_SCORE=-3;
export const MAX_ACTIVE=12;  // per site; the weakest is retired to make room
export const PROMPT_LIMIT=5;
const MAX_LENGTH=280;

// The site a page belongs to: a hiring platform's own domain (myworkdayjobs.com, icims.com), else the employer's.
export function platformKey(url,platforms=HIRING_PLATFORMS){
 let host;try{host=new URL(url).hostname.toLowerCase();}catch{return '';}
 return platforms.find(d=>host===d||host.endsWith('.'+d))??host.split('.').slice(-2).join('.');
}

export async function readHints(path=HINTS_PATH){
 if(!path)return {};
 try{const data=JSON.parse(await readFile(path,'utf8'));return data&&typeof data==='object'&&!Array.isArray(data)?data:{};}catch{return {};}
}

// One writer at a time: several workers finish runs at once.
async function update(path,change){
 if(!path)return;
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 let lock;
 for(let attempt=0;!lock;attempt++){
  try{lock=await acquireLock(path+'.lock');}catch(error){if(error.code!=='EEXIST'||attempt>=50)throw error;await new Promise(r=>setTimeout(r,100));}
 }
 try{
  const data=await readHints(path);const result=await change(data);
  await writeFile(path+'.tmp',JSON.stringify(data,null,2),{mode:0o600});await rename(path+'.tmp',path);
  return result;
 }finally{await lock.close().catch(()=>{});await unlink(path+'.lock').catch(()=>{});}
}

const active=entries=>(entries??[]).filter(h=>h.status==='active');
const ranked=entries=>active(entries).sort((a,b)=>b.score-a.score||String(b.created_at).localeCompare(String(a.created_at)));

// His own instructions for a site: always shown first, never scored or retired (lesson 455).
export const STANDING_HINTS={
 'icims.com':[{id:'standing-icims-profile',text:"His instruction (2026-11-10): an iCIMS application opens on a candidate profile page. Compare every prefilled field with the supplied facts and correct any that differ, then click 'Update Profile': it is a continue step, not the final Submit. On each later page check the prefilled answers the same way before clicking Next at the bottom."}],
};
// The hints a step on this page sees: [{id,text}], best first.
export async function hintsFor(url,{path=HINTS_PATH,limit=PROMPT_LIMIT,standing=STANDING_HINTS}={}){
 const site=platformKey(url);if(!site)return [];
 return [...(standing[site]??[]),...ranked((await readHints(path))[site]).slice(0,limit).map(({id,text})=>({id,text}))];
}

// His personal values: profile keys that hold who he is or where he lives.
const PERSONAL_KEYS=/^(?:first|last|full|preferred|legal|sa ?legal)?_?name$|name$|^(?:email|phone|mobile|city|citysearch|addresscity|address(?:line)?\d?|street.*|zip.*|postal.*|dateofbirth|dob|birth.*|linkedin|github|portfolio|website)$/i;
function personalValues(profile={}){
 const answers=profile.answers??{};
 return Object.entries(answers).filter(([k,v])=>PERSONAL_KEYS.test(k)&&typeof v==='string'&&v.trim().length>=3).map(([,v])=>v.trim().toLowerCase());
}
const PII=[
 /[\w.+-]+@[\w-]+\.[\w.-]+/,                                  // email
 /\+?\d[\d\-\s().]{7,}\d/,                                    // phone or long number
 /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Lane|Ln|Dr|Drive|Ter|Terrace|Ct|Court|Way)\b/,  // street address
 /(?:sk-|ghp_|xox[baprs]-|AKIA|Bearer\s)[A-Za-z0-9_-]{8,}/,   // keys and tokens
 /\b[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*[A-Za-z][A-Za-z0-9_-]{14,}\b/, // session ids, req ids, run ids
 /password|passcode|verification code/i,
];
// True when a hint carries nothing personal: no contact details, ids, secrets or his own values.
export function piiClean(text,profile={}){
 const value=String(text??'');
 if(PII.some(p=>p.test(value)))return false;
 const lower=value.toLowerCase();const digits=value.replace(/\D/g,'');
 return !personalValues(profile).some(v=>lower.includes(v)||(v.replace(/\D/g,'').length>=7&&digits.includes(v.replace(/\D/g,''))));
}

// Rough stems so "clicking" and "click" count as one word.
const words=text=>new Set(String(text).toLowerCase().replace(/[^a-z0-9 ]+/g,' ').split(/\s+/).filter(w=>w.length>2).map(w=>w.replace(/(?:ing|ed|es|s)$/,'')));
export function sameHint(a,b){
 const x=words(a),y=words(b);if(!x.size||!y.size)return false;
 let shared=0;for(const w of x)if(y.has(w))shared++;
 return shared/(x.size+y.size-shared)>=0.7;
}
const clean=text=>String(text??'').replace(/\s+/g,' ').trim();

// A hint that tells the step model to give up on a field (expect it to need approval, flag it, leave it for the
// applicant) is not site knowledge: Honda 15037 learned "expect Current Employer, Company Name and Job Title to need
// approved answers" after one weak model flagged fields the profile's work history fills (lesson 448).
export const GIVE_UP_HINT=/\b(?:expect|assume|leave|send|flag|mark|route|escalate)\b[^.]{0,80}\b(?:approv(?:al|ed)|applicant|review|human)\b|\bneed(?:s|ed)? (?:approved|the applicant'?s?) answers?\b|\bflag(?:ged)? for (?:approval|review)\b/i;
// Store new hints for a site; returns those added. Duplicates of an active hint, anything personal and give-up advice are dropped.
export async function recordHints(site,texts,{path=HINTS_PATH,profile={},runId,now=new Date()}={}){
 if(!site)return [];
 return update(path,data=>{
  const entries=data[site]??=[];const added=[];
  for(const raw of texts??[]){
   const text=clean(raw);
   if(text.length<12||text.length>MAX_LENGTH||!piiClean(text,profile)||GIVE_UP_HINT.test(text))continue;
   if(active(entries).some(h=>sameHint(h.text,text)))continue;
   const hint={id:randomBytes(4).toString('hex'),text,score:0,status:'active',uses:0,wins:0,losses:0,created_at:now.toISOString(),source_run:runId??null};
   entries.push(hint);added.push(hint);
  }
  // Too many on one site: retire the weakest (lowest score, then oldest).
  const live=active(entries).sort((a,b)=>a.score-b.score||String(a.created_at).localeCompare(String(b.created_at)));
  for(const hint of live.slice(0,Math.max(0,live.length-MAX_ACTIVE)))Object.assign(hint,{status:'retired',retired_at:now.toISOString(),retired_because:'room for newer hints'});
  return added;
 })??[];
}

// +1 for a run that submitted, -1 for a technical failure; other outcomes leave the score alone.
export function outcomeDelta(state={}){
 if(state.submitted||['submitted','submitted_pending_receipt','completed'].includes(state.status))return 1;
 if(state.status==='failed')return -1;
 return 0;
}

// used: {site:[hintId,...]} seen by this run's steps.
export async function scoreHints(used,delta,{path=HINTS_PATH,now=new Date()}={}){
 if(!delta||!Object.values(used??{}).some(ids=>ids.length))return;
 await update(path,data=>{
  for(const [site,ids] of Object.entries(used))for(const hint of data[site]??[]){
   if(!ids.includes(hint.id)||hint.status!=='active')continue;
   hint.score+=delta;hint.uses+=1;if(delta>0)hint.wins+=1;else hint.losses+=1;
   if(hint.score<=RETIRE_SCORE)Object.assign(hint,{status:'retired',retired_at:now.toISOString(),retired_because:`score ${hint.score}`});
  }
 });
}

const SYSTEM='You distill durable, reusable knowledge about one job-application website from a finished automation run: the stable map of the site (where a control hides, what must load or be waited for, which button moves on, traps that cost steps), never a narration of this run. Never include personal data (names, emails, phone numbers, addresses, dates of birth), answers to questions, passwords, codes, URLs with ids, or anything about this applicant or employer that would not hold for other postings on the same site. Each hint is one plain sentence under 240 characters. Return worth_saving=false when the run taught nothing durable or the existing hints already cover it.';
export const DISTIL_SCHEMA={type:'object',additionalProperties:false,properties:{worth_saving:{type:'boolean'},hints:{type:'array',maxItems:3,items:{type:'string'}}},required:['worth_saving','hints']};

export function distilPrompt({site,outcome,events=[],history=[],existing=[]}){
 return JSON.stringify({site,outcome,existingHints:existing.map(h=>h.text),
  recentEvents:events.slice(-40).map(e=>String(e.message??e).slice(0,200)),
  recentActions:history.slice(-30).map(h=>({action:h.action,control:String(h.control??'').slice(0,80)}))});
}

// One structured call on the run's own engine and model (Claude, Codex or OpenCode); agy runs skip distilling.
// It needs no tools: Claude gets none of the worker's tool flags and Codex runs read-only.
async function ask({engine,command,model,prompt,execImpl,cwd=ROOT}){
 const timeout=90000;
 if(engine==='claude'){
  const args=['-p','--output-format','json','--json-schema',JSON.stringify(DISTIL_SCHEMA),'--append-system-prompt',SYSTEM,'--no-session-persistence',...(model?['--model',model]:[])];
  const {code,stdout}=await execImpl(command||'claude',args,prompt,{cwd,timeout});
  if(code!==0)throw new Error(`Claude CLI failed (exit ${code})`);
  const output=JSON.parse(stdout);const result=Array.isArray(output)?output.findLast(e=>e.type==='result'||e.structured_output):output;
  return result?.structured_output??JSON.parse(result?.result??'null');
 }
 if(engine==='codex'){
  const dir=await mkdtemp(join(tmpdir(),'jobagent-hints-'));
  try{
   await writeFile(join(dir,'schema.json'),JSON.stringify(DISTIL_SCHEMA));
   const args=['exec','--skip-git-repo-check','--ephemeral','-s','read-only','--output-schema',join(dir,'schema.json'),'--json','-C',cwd,...(model?['-m',model]:[]),'-'];
   const {code,stdout}=await execImpl(command||'codex',args,`${SYSTEM}\n\n${prompt}`,{cwd,timeout});
   const message=stdout.split('\n').flatMap(l=>{try{return[JSON.parse(l)];}catch{return[];}}).filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message').at(-1)?.item?.text;
   if(code!==0||!message)throw new Error(`Codex CLI failed (exit ${code})`);
   return JSON.parse(message);
  }finally{await rm(dir,{recursive:true,force:true});}
 }
 if(engine==='opencode'&&model){
  const config=JSON.stringify({agent:{jobagent:{mode:'primary',tools:{'*':false},permission:{'*':'deny'}}}});
  const {code,stdout}=await execImpl(command||'opencode',['run','--agent','jobagent','--model',model,'--format','json'],`${SYSTEM}\nReturn only JSON matching ${JSON.stringify(DISTIL_SCHEMA)}.\n\n${prompt}`,{cwd,timeout,env:{OPENCODE_CONFIG_CONTENT:config}});
  const text=stdout.split('\n').flatMap(l=>{try{const e=JSON.parse(l);return [e.part?.text,e.text].filter(Boolean);}catch{return[];}}).at(-1)??'';
  const json=text.match(/\{[\s\S]*\}/)?.[0];
  if(code!==0||!json)throw new Error('OpenCode returned no hints');
  return JSON.parse(json);
 }
 return null;
}

// After a run: score the hints its steps saw, then ask for new ones about the site it spent most steps on.
// Never throws; a failure here must not change the run's outcome.
export async function learnFromRun({state={},used={},steps={},events=[],history=[],engine,command,model,execImpl,profile={},runId,path=HINTS_PATH,enabled=true,log=()=>{}}={}){
 const result={scored:0,added:[]};
 try{
  const delta=outcomeDelta(state);
  if(delta&&path){await scoreHints(used,delta,{path});result.scored=Object.values(used).reduce((n,ids)=>n+ids.length,0);}
  const site=Object.entries(steps).sort((a,b)=>b[1]-a[1])[0]?.[0];
  // Only finished runs that took real steps teach anything; a stop or skip does not.
  if(!enabled||!path||!site||!execImpl||history.length<4||['stopped','skipped','running'].includes(state.status))return result;
  const existing=ranked((await readHints(path))[site]);
  const answer=await ask({engine,command,model,execImpl,prompt:distilPrompt({site,outcome:{status:state.status,submitted:Boolean(state.submitted),message:String(state.message??'').slice(0,300)},events,history,existing})});
  if(answer?.worth_saving&&Array.isArray(answer.hints))result.added=await recordHints(site,answer.hints,{path,profile,runId});
  if(result.added.length)await log(`Learned ${result.added.length} hint(s) about ${site} for later runs.`);
 }catch(error){await log(`Site hints were not updated: ${String(error?.message??error).slice(0,160)}`);}
 return result;
}
