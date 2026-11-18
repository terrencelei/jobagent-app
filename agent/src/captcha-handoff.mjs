// Free fallback for any CAPTCHA (reCAPTCHA, hCaptcha): show the live, headed browser window,
// notify the user on this Mac, and wait for him to solve it. The page's own pending
// submission then continues; nothing here clicks Submit. See docs/captcha-free.md.
import {execFile} from 'node:child_process';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {solveRecaptchaAudio,recaptchaFrames} from './captcha-audio.mjs';
import {solveCaptchaLocally} from './captcha-local.mjs';
import {solveWithVendor,vendorDetect,vendorSolver} from './captcha-vendor.mjs';

// Tier 0 is the supplied package (vendor/captcha-solver) as written; the ESM port runs only when
// the package itself cannot load or throws.
export async function solveCaptchaPackage(page,opts={}){
 try{return await solveWithVendor(page,opts);}
 catch(e){await opts.log?.(`Package CAPTCHA solver failed (${String(e?.message??e).slice(0,120)}); using the port`);return solveCaptchaLocally(page,opts);}
}

const quote=s=>JSON.stringify(String(s).replace(/[\r\n]+/g,' ').slice(0,200));
export function notifyMac(title,message,{exec=execFile}={}){
 return new Promise(resolve=>exec('osascript',['-e',`display notification ${quote(message)} with title ${quote(title)} sound name "Glass"`],()=>resolve()));
}

// In his own finish-yourself Chrome a sign-in or verification stop needs no Resume click: once he gets past the
// page (the address changes and stays changed), filling continues by itself. Resume still works (lesson 453).
export async function waitForPageAdvance({url,closed=()=>false,command=async()=>null,sleep=ms=>new Promise(r=>setTimeout(r,ms)),pollMs=500,stablePolls=6,timeoutMs=Infinity,now=Date.now}){
 const bare=u=>String(u||'').split('#')[0];const from=bare(url());let moved=0;const deadline=now()+timeoutMs;
 for(;;){
  if(now()>deadline)return 'timeout';
  if((await command())?.action==='resume')return 'resume';
  if(closed())throw new Error('Your Chrome window was closed');
  if(bare(url())!==from){if(++moved>=stablePolls)return 'advanced';}else moved=0;
  await sleep(pollMs);
 }
}
export async function waitForHuman(page,{challengeVisible,company='',timeoutMs=600000,pollMs=2000,settleMs=3000,notify=notifyMac,log=()=>{},now=Date.now,wait=ms=>page.waitForTimeout(ms)}={}){
 await page.bringToFront().catch(()=>{});
 await notify('JobAgent needs a CAPTCHA',`${company||'An application'} is waiting in the browser window. Solve the challenge; it submits itself.`);
 await log(`Waiting up to ${Math.round(timeoutMs/60000)} min for you to solve the CAPTCHA in the open browser window`);
 const deadline=now()+timeoutMs;let clearSince=null;
 while(now()<deadline){
  if(page.isClosed())return {completed:false,reason:'browser window was closed'};
  // A challenge iframe can disappear between puzzle pages or while its normal
  // callback navigates. Require a stable cleared state before ending the handoff.
  if(await challengeVisible(page))clearSince=null;
  else{clearSince??=now();if(now()-clearSince>=settleMs)return {completed:true,by:'human'};}
  await wait(pollMs);
 }
 return {completed:false,reason:`CAPTCHA was not solved within ${Math.round(timeoutMs/60000)} min`};
}

// Tiered: the local solver (every vendor, works headless; it runs the reCAPTCHA audio tier itself),
// then audio alone for a reCAPTCHA the local solver did not reach, then the human handoff when the
// window is visible. manualFirst (his per-posting choice) skips both solvers and hands the window to him.
// In the hidden relay Chrome the package's extensions (solver_ext, the hCaptcha worker) work the
// challenge themselves; the package's waitForExtensionSolver watches for their token.
export const waitForRelayExtensions=(page,{seconds=90}={})=>vendorSolver().waitForExtensionSolver(page,seconds);

export async function resolveChallengeFree(page,{challengeVisible,headless,company,log=()=>{},local=solveCaptchaPackage,audio=solveRecaptchaAudio,human=waitForHuman,timeoutMs,manualFirst=false,relay=false,extensions=waitForRelayExtensions}={}){
 const tried=[];
 let localTried=null;
 if(!(manualFirst&&!headless)){
  const r=await local(page,{company,log}).catch(e=>({solved:false,type:'error',error:`local solver error: ${String(e?.message??e).slice(0,120)}`}));
  if(r.solved&&!(await challengeVisible(page).catch(()=>true)))return {completed:true,by:`local:${r.type}`,how:r.how};
  if(r.type&&r.type!=='none'){
   localTried=r;
   tried.push(`local solver (${r.vendorText||r.type}): ${r.error||r.how||'challenge still visible'}`);
   if(r.wall)return {completed:false,wall:true,reason:tried.join('; ')};
   if(r.declined)return {completed:false,declined:true,reason:[...tried,'the vision model declined to solve it'].join('; ')};
   if(r.policy)return {completed:false,policy:r.policy,reason:[...tried,r.policy].join('; ')};
  }
 }
 if(relay&&!(manualFirst&&!headless)){
  await log('Waiting for the relay Chrome\'s CAPTCHA extensions');
  const r=await extensions(page).catch(e=>({solved:false,by:`error: ${String(e?.message??e).slice(0,80)}`}));
  if(r.solved&&!(await challengeVisible(page).catch(()=>true)))return {completed:true,by:'relay-extension'};
  tried.push(`relay Chrome extensions: ${r.by||'not solved'}`);
 }
 // The local solver already ran the audio clips for a reCAPTCHA it saw; another pass only draws Google's refusal.
 if(recaptchaFrames(page).bframe&&!(manualFirst&&!headless)&&!/recaptcha/.test(localTried?.type||'')){
  // A failed download, transcription or frame call must still reach the hand-off and paid tier.
  const result=await audio(page,{log}).catch(e=>({completed:false,reason:`audio solver error: ${String(e?.message??e).slice(0,120)}`}));
  if(result.completed&&!(await challengeVisible(page).catch(()=>true)))return {completed:true,by:'audio'};
  tried.push(result.reason??'challenge still visible after audio');
  await log(`Free audio tier did not clear the CAPTCHA: ${tried.at(-1)}`);
 }
 if(headless||relay)return {completed:false,reason:[...tried,relay?'the relay Chrome is hidden, so no hand-off window':'browser is headless, so no handoff window'].join('; ')};  // unattended runs stay headless (2026-10-17); no headed retry
 const result=await human(page,{challengeVisible,company,log,...(timeoutMs?{timeoutMs}:{})}).catch(e=>({completed:false,reason:`hand-off error: ${String(e?.message??e).slice(0,120)}`}));
 return result.completed?result:{...result,reason:[...tried,result.reason].join('; ')};
}

// A CAPTCHA is pending while a challenge frame is open, or a widget's response field is
// still empty (hCaptcha/reCAPTCHA checkboxes are too small to count as an open challenge).
// Lever keeps the hCaptcha response in an <input>, other sites in a <textarea>.
export async function captchaPending(page,{challengeVisible,detect=p=>vendorDetect().detect(p)}={}){
 if(challengeVisible&&await challengeVisible(page))return true;
 // The package's detector also sees widgets nested in other frames and the non-Google vendors.
 if(detect&&(await detect(page).catch(()=>null))?.live)return true;
 return page.evaluate(()=>{
  const widget=[...document.querySelectorAll('iframe')].some(f=>/hcaptcha\.com|\/recaptcha\/(?:api2|enterprise)\/anchor/.test(f.src||'')&&f.getBoundingClientRect().width>0);
  if(!widget)return false;
  const fields=[...document.querySelectorAll('[name="h-captcha-response"],[name="g-recaptcha-response"]')];
  return fields.length>0&&fields.every(f=>!f.value);
 }).catch(()=>false);
}

// Postings that showed a CAPTCHA run headed next time: audio and the handoff need a window.
const canonical=url=>{try{const u=new URL(url);return u.origin+u.pathname;}catch{return String(url);}};
const historyPath=stateDir=>join(stateDir,'captcha-postings.json');
export async function captchaSeen(stateDir,url){
 try{return Boolean(JSON.parse(await readFile(historyPath(stateDir),'utf8'))[canonical(url)]);}catch{return false;}
}
// A posting marked manualFirst goes straight to his hands in the visible window, no audio.
export async function captchaManualFirst(stateDir,url){
 try{return JSON.parse(await readFile(historyPath(stateDir),'utf8'))[canonical(url)]?.manualFirst===true;}catch{return false;}
}
export async function recordCaptcha(stateDir,url,kind){
 let seen={};try{seen=JSON.parse(await readFile(historyPath(stateDir),'utf8'));}catch{}
 const manualFirst=seen[canonical(url)]?.manualFirst===true;
 seen[canonical(url)]={kind,at:new Date().toISOString(),...(manualFirst?{manualFirst}:{})};
 const tmp=historyPath(stateDir)+'.tmp';await writeFile(tmp,JSON.stringify(seen,null,1),{mode:0o600});await rename(tmp,historyPath(stateDir));
}

// A visible checkbox widget (reCAPTCHA anchor, hCaptcha #frame=checkbox) is something he can
// click now; an invisible one (Lever's hCaptcha enclave) only challenges at Submit.
// Every frame, like visibleApplicationChallenge (an iCIMS form lives in an iframe of its own).
export async function captchaCheckboxVisible(page){
 for(const frame of typeof page.frames==='function'?page.frames():[page]){
  const shown=await frame.evaluate(()=>[...document.querySelectorAll('iframe')].some(f=>{
   const src=f.src||'',r=f.getBoundingClientRect(),s=getComputedStyle(f);
   return /hcaptcha\.com.*frame=checkbox|\/recaptcha\/(?:api2|enterprise)\/anchor(?!.*size=invisible)/.test(src)
    &&r.width>=200&&r.width<=420&&r.height>=60&&r.height<=120&&s.visibility!=='hidden'&&s.display!=='none'&&Number(s.opacity)!==0;
  })).catch(()=>false);
  if(shown)return true;
 }
 return false;
}

// Boards whose application forms challenge at Submit (Ashby reCAPTCHA Enterprise, Lever hCaptcha,
// JazzHR reCAPTCHA). A headless first run there can never be solved, so open these headed at once.
const CAPTCHA_BOARDS=/^(?:jobs\.ashbyhq\.com|jobs\.lever\.co|[a-z0-9-]+\.theresumator\.com)$/i;
export function captchaLikely(url){try{return CAPTCHA_BOARDS.test(new URL(url).hostname);}catch{return false;}}

