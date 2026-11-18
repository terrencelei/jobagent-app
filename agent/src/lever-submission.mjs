// Observe Lever's normal submission and manual CAPTCHA callback. Never read or
// modify CAPTCHA tokens, execute widgets, click Submit, or resend a POST. The one exception is
// src/lever-retry.mjs: a single Submit after Lever explicitly refused verification (his request, lesson 420).
import {captchaPending} from './captcha-handoff.mjs';
import {createHash} from 'node:crypto';
const verificationFailure=/\b(?:there was an error verifying (?:your |this )?application|unable to verify (?:your |this |my )?application|(?:could not|couldn[’']t|cannot) verify (?:your |this )?application|application (?:could not|cannot) be verified|(?:captcha|verification) (?:has )?(?:failed|expired|invalid))\b/i;
const normalize=value=>String(value??'').replace(/\s+/g,' ').trim();
const exactLeverApplication=(url,job)=>{
 try{const actual=new URL(url),expected=new URL(job.url);return expected.hostname==='jobs.lever.co'&&actual.origin===expected.origin&&actual.pathname.replace(/\/$/,'')===expected.pathname.replace(/\/$/,'');}catch{return false;}
};
export function leverVerificationFailure(text){
 const body=normalize(text),match=body.match(verificationFailure);
 return match?match[0]:null;
}
export function monitorLeverSubmission(page,job,{onEvidence=()=>{},onRequest=()=>{}}={}){
 const pending=new Set(),responses=[],requests=[];
 const request=req=>{
  if(req.method()!=='POST'||!exactLeverApplication(req.url(),job))return;
  const evidence={source:'lever_application_request',jobId:job.id,applicationUrl:job.url,url:req.url(),startedAt:new Date().toISOString()};
  requests.push(evidence);try{Promise.resolve(onRequest(evidence)).catch(()=>{});}catch{}
 };
 const response=async res=>{
  if(res.request().method()!=='POST'||!exactLeverApplication(res.url(),job))return;
  const task=(async()=>{
   // Only retain recognized errors and a body hash; never store form values,
   // submitted documents, tokens, cookies, headers or arbitrary response bodies.
   const text=await res.text().catch(()=>'');
   const evidence={source:'lever_application_response',jobId:job.id,applicationUrl:job.url,
    url:res.url(),status:res.status(),receivedAt:new Date().toISOString(),
    responseBodySha256:createHash('sha256').update(text).digest('hex'),
    verificationError:leverVerificationFailure(text)};
   responses.push(evidence);await onEvidence(evidence);
  })();pending.add(task);try{await task;}catch{}finally{pending.delete(task);}
 };
 page.on('request',request);page.on('response',response);
 return {requests:()=>requests.map(r=>({...r})),responses:()=>responses.map(r=>({...r})),flush:async()=>{
   let timer;try{await Promise.race([Promise.allSettled([...pending]),new Promise(resolve=>{timer=setTimeout(resolve,2000);})]);}finally{clearTimeout(timer);}
  },stop:()=>{page.off('request',request);page.off('response',response);}};
}
export async function leverSubmissionOutcome(page,job,{monitor,timeoutMs=15000,pollMs=250,wait=ms=>page.waitForTimeout(ms)}={}){
 if(!exactLeverApplication(job.url,job))return null;
 const until=Date.now()+timeoutMs;
 do{
  if(!exactLeverApplication(page.url(),job))return null;
  const visibleText=await page.locator('body').innerText().catch(()=>'');
  const error=leverVerificationFailure(visibleText);
  if(error){
   await monitor?.flush();const response=monitor?.responses().at(-1);
   return {status:'verification_rejected',retrySafe:true,source:'lever_visible_verification_error',
    jobId:job.id,applicationUrl:job.url,url:page.url(),observedAt:new Date().toISOString(),
    verificationError:error,...(response?{response}:{})};
  }
  const responses=monitor?.responses()||[];
  const rejected=responses.findLast(r=>r.status>=400&&r.verificationError);
  if(rejected)return {status:'verification_rejected',retrySafe:true,...rejected};
  // Leaving this exact application page gives the general acceptance checker the
  // next decision. A CAPTCHA disappearing alone is never employer acceptance.
  if(!exactLeverApplication(page.url(),job))return null;
  if(Date.now()>=until)break;
  await wait(pollMs);
 }while(true);
 return null;
}

// The employer rejected verification, so keep this same page available for a
// normal manual retry. Only the applicant clicks/solves; this watcher never does.
export async function waitForManualLeverRetry(page,job,{monitor,timeoutMs=600000,pollMs=500,
 now=Date.now,wait=ms=>page.waitForTimeout(ms),afterResponseCount=monitor.responses().length}={}){
 const baseline=afterResponseCount,until=now()+timeoutMs;
 while(now()<until){
  if(page.isClosed())return {completed:false,reason:'Browser window was closed'};
  if(!exactLeverApplication(page.url(),job))return {completed:true,by:'manual_navigation'};
  const latest=monitor.responses().at(-1);
  if(monitor.responses().length>baseline&&latest&&!latest.verificationError){
   if(latest.status>=400)return {completed:false,reason:`Employer rejected the manual application request (HTTP ${latest.status})`};
   const text=await page.locator('body').innerText().catch(()=>'');
   if(!leverVerificationFailure(text))return {completed:true,by:'manual_post',response:latest};
  }
  await wait(pollMs);
 }
 return {completed:false,reason:'Employer verification was not completed during the ten-minute manual handoff'};
}


// A rejected POST may render a fresh empty invisible widget. It is not the
// challenge the applicant just solved; hand control to the rejection handler.
export async function leverChallengePending(page,job,{monitor,challengeVisible,pending=captchaPending}={}){
 if(await leverSubmissionOutcome(page,job,{monitor,timeoutMs:0}))return false;
 return pending(page,{challengeVisible});
}
