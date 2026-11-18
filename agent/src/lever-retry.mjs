// One CAPTCHA-free retry after Lever refuses verification (his request, 2026-11-02; lessons 419-420).
// Zoox 10953 and 6542: Lever answered the first Submit (made with a solved hCaptcha image challenge) with
// "There was an error verifying your application" and emptied the resume field. Re-attaching the resume and
// pressing Submit again in the same page asked for no challenge, and Lever accepted it both times.
// A refusal is Lever saying nothing was received, so this one retry is not a duplicate. It runs at most once
// per page, and only right after an explicit verification-error response to an application POST.
import {leverVerificationFailure} from './lever-submission.mjs';
import {humanClick} from './human-input.mjs';

const RESUME_INPUT='input[type=file][name="resume"]';
const SUBMIT='#btn-submit, button[type=submit]:has-text("Submit application"), button:has-text("Submit application")';
const sleep=(page,ms)=>page.waitForTimeout(ms);

// The newest application response is an explicit verification refusal.
export function lastResponseRefused(monitor){
 const latest=monitor?.responses().at(-1);
 return Boolean(latest&&latest.status>=400&&latest.verificationError);
}

async function onApplicationPage(page,job){
 try{const a=new URL(page.url()),e=new URL(job.url);return a.origin===e.origin&&a.pathname.replace(/\/$/,'')===e.pathname.replace(/\/$/,'');}catch{return false;}
}

// Re-attach the resume when the refusal emptied it, then press Submit once with humanlike input.
// Returns {status:'accepted'|'refused'|'challenge'|'no_response'|'not_retried', ...}.
export async function leverRetryOnce(page,job,{monitor,resumePath,log=async()=>{},settleMs=1500,uploadWaitMs=20000,outcomeMs=30000}={}){
 if(!lastResponseRefused(monitor))return {status:'not_retried',reason:'Lever has not refused an application POST on this page'};
 await sleep(page,settleMs);
 const input=page.locator(RESUME_INPUT).first();
 let reattached=false;
 if(resumePath&&await input.count()&&!(await input.evaluate(el=>el.files?.length||0).catch(()=>0))){
  await input.setInputFiles(resumePath);reattached=true;
  // Lever uploads and parses the resume in the background; wait for its stored-file id, else a fixed pause.
  const start=Date.now();
  while(Date.now()-start<uploadWaitMs){
   const stored=await page.locator('input[name="resumeStorageId"]').first().inputValue().catch(()=>null);
   if(stored||(stored===null&&Date.now()-start>8000))break;
   await sleep(page,500);
  }
 }
 const submit=page.locator(SUBMIT).first();
 if(!await submit.count())return {status:'not_retried',reason:'Submit button not found after the refusal'};
 const before=monitor.responses().length;
 await log(`Lever refused the first Submit ("${monitor.responses().at(-1).verificationError}"). ${reattached?'Re-attached the resume and pressed':'Pressed'} Submit once more in the same page (lesson 419).`);
 await humanClick(page,submit);
 const until=Date.now()+outcomeMs;
 while(Date.now()<until){
  if(page.isClosed())return {status:'no_response',reason:'The window was closed'};
  if(!await onApplicationPage(page,job))return {status:'accepted',by:'navigation',url:page.url()};
  const responses=monitor.responses();
  if(responses.length>before){
   const latest=responses.at(-1);
   if(latest.status>=400||latest.verificationError)return {status:'refused',response:latest};
   const text=await page.locator('body').innerText().catch(()=>'');
   if(!leverVerificationFailure(text))return {status:'accepted',by:'response',response:latest};
  }
  const challenge=await page.locator('iframe[src*="hcaptcha"][src*="frame=challenge"]').evaluateAll(fs=>fs.some(f=>f.getBoundingClientRect().height>100&&getComputedStyle(f).visibility!=='hidden')).catch(()=>false);
  if(challenge&&responses.length===before)return {status:'challenge'};
  await sleep(page,500);
 }
 return {status:'no_response',reason:'No answer from Lever within 30 s of the retry'};
}

// His Finish in my Chrome window on Lever: wait while he solves the CAPTCHA and presses Submit; if Lever refuses
// it, make the one retry for him. Returns when Lever accepts, refuses twice, the window closes, or time runs out.
export async function watchLeverHandoff(page,job,{monitor,resumePath,log=async()=>{},timeoutMs=45*60000,pollMs=1000}={}){
 const until=Date.now()+timeoutMs;let seen=monitor.responses().length,retried=false;
 while(Date.now()<until){
  if(page.isClosed())return {status:'closed'};
  if(!await onApplicationPage(page,job))return {status:'accepted',by:'his_submit',url:page.url()};
  const responses=monitor.responses();
  if(responses.length>seen){
   seen=responses.length;
   if(lastResponseRefused(monitor)){
    if(retried)return {status:'refused',response:responses.at(-1)};
    retried=true;
    const retry=await leverRetryOnce(page,job,{monitor,resumePath,log});
    if(retry.status==='challenge'){await log('The retry showed a CAPTCHA: solve it and press Submit in the window.');seen=monitor.responses().length;continue;}
    return retry;
   }
  }
  await page.waitForTimeout(pollMs).catch(()=>{});
 }
 return {status:'timeout'};
}
