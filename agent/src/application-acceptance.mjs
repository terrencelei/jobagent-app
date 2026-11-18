// Positive employer acknowledgements after one authorized submission. A click, a
// cleared CAPTCHA, or an email verification step is never acceptance evidence.
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';

const hash=value=>createHash('sha256').update(value).digest('hex');
const success=/\b(?:your application (?:has (?:successfully )?been |was |is )?(?:successfully )?(?:submitted|received)|(?:we have|we've) received your application|thank you for (?:applying|submitting your application)|application (?:successfully submitted|submitted successfully|received successfully))\b/i;
const blocked=/\b(?:verify (?:your )?(?:email|identity)|enter (?:the |your )?(?:security|verification) code|check your email (?:to (?:verify|confirm)|for (?:a |the |your )?(?:security|verification) code)|complete (?:the |this )?(?:captcha|verification)|application (?:was |has )?(?:not|failed to) (?:been )?(?:submit|submitted)|unable to submit|something went wrong)\b/i;
const sameHost=(a,b)=>{try{
 const x=new URL(a),y=new URL(b);if(!/^https?:$/.test(x.protocol)||!/^https?:$/.test(y.protocol)||!x.hostname)return false;
 if(x.hostname===y.hostname)return true;
 // Greenhouse migrated boards.greenhouse.io to job-boards.greenhouse.io.
 // Only the same employer board + requisition may cross that known alias.
 const greenhouse=new Set(['boards.greenhouse.io','job-boards.greenhouse.io']);
 const posting=u=>u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)(?:\/|$)/)?.slice(1).join('/');
 return greenhouse.has(x.hostname)&&greenhouse.has(y.hostname)&&!!posting(x)&&posting(x)===posting(y);
}catch{return false;}};

// His rule (2026-11-02, lesson 435): a submitted application turns the page into a confirmation. A page with no form
// fields left (fieldCount 0) whose text reads as one counts even without the full stock phrases.
const looseSuccess=/\b(?:thank you|thanks|application (?:received|submitted|complete)|received|submitted|success(?:fully)?|confirmation|all set|you(?:'|’)re all done)\b/i;
export function webpageAcceptance({text='',url,submittedFromUrl,job={},submittedAt,now=new Date(),challengeVisible=false,submitVisible=false,errors=[],fieldCount}={}) {
 const attempt=Date.parse(submittedAt),time=new Date(now);
 if(!Number.isFinite(attempt)||!Number.isFinite(+time)||attempt>+time+5000||!sameHost(url,submittedFromUrl||job.url)||challengeVisible||submitVisible||errors.some(Boolean))return null;
 const body=String(text).replace(/\s+/g,' ').trim();
 if(blocked.test(body))return null;
 let match=body.match(success);
 // Workday sometimes shows a requisition-specific status card instead of a
 // thank-you page. A generic Submitted label elsewhere in the portal is unsafe.
 if(!match&&/\bApplication Under Review\b/i.test(body)){
  const req=(String(job.url).match(/_(JR?\d+[\w-]*)/i)||[])[1]?.replace(/-\d+$/,'');
  if(req&&body.includes(req))match=body.match(/\bApplication Under Review\b/i);
 }
 if(!match&&fieldCount===0&&body.length<3000)match=body.match(looseSuccess);
 if(!match)return null;
 return {source:'webpage',url,applicationUrl:job.url,submittedFromUrl:submittedFromUrl||job.url,
  jobId:job.id,company:job.company,title:job.title,submittedAt:new Date(attempt).toISOString(),
  confirmedAt:time.toISOString(),quote:match[0],pageTextSha256:hash(body),...(match[0]==='Application Under Review'?{requisition:(String(job.url).match(/_(JR?\d+[\w-]*)/i)||[])[1]?.replace(/-\d+$/,'')}:{} )};
}

export function verifiedWebpageAcceptance(evidence,job) {
 if(evidence?.source!=='webpage'||!job?.url||evidence.applicationUrl!==job.url||
  (job.id!=null&&String(evidence.jobId).replace(/^jobagent-/,'')!==String(job.id).replace(/^jobagent-/,''))||
  evidence.company!==job.company||!/^[a-f0-9]{64}$/.test(evidence.pageTextSha256||''))return null;
 // Re-run the acknowledgement/host/time checks, never trust a bare status flag.
 const checked=webpageAcceptance({text:evidence.quote,url:evidence.url,submittedFromUrl:evidence.submittedFromUrl,
  job,submittedAt:evidence.submittedAt,now:evidence.confirmedAt});
 // A status-card acknowledgement includes its requisition to remain verifiable.
 if(!checked&&evidence.quote==='Application Under Review'){
  const req=(String(job.url).match(/_(JR?\d+[\w-]*)/i)||[])[1]?.replace(/-\d+$/,'');
  if(req&&evidence.requisition===req&&webpageAcceptance({text:`${req} Application Under Review`,url:evidence.url,
   submittedFromUrl:evidence.submittedFromUrl,job,submittedAt:evidence.submittedAt,now:evidence.confirmedAt}))return evidence;
 }
 return checked?evidence:null;
}

export async function collectWebpageAcceptance(page,job,{submittedAt,submittedFromUrl,screenshotPath}={}) {
 const read=frame=>frame.evaluate(()=>{
  const visible=e=>!!(e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
  return {text:document.body?.innerText||'',submitVisible:[...document.querySelectorAll('button,input[type="submit"]')]
   .some(e=>visible(e)&&/^(?:submit(?: application)?|send application|apply now)$/i.test((e.innerText||e.value||'').trim())),
   challengeVisible:[...document.querySelectorAll('iframe')].some(e=>visible(e)&&/recaptcha\/(?:api2|enterprise)\/bframe|hcaptcha.*(?:challenge|frame=challenge)/i.test(e.src)),
   errors:[...document.querySelectorAll('[aria-invalid="true"],[data-automation-id="errorMessage"],.field-error,.validation-error')]
    .filter(visible).map(e=>e.innerText||'invalid field'),
   // Fillable fields still on the page, shadow roots included: 0 means the form is gone.
   fieldCount:(()=>{let n=0;const walk=r=>{for(const e of r.querySelectorAll('*')){if(e.matches('input:not([type=hidden]):not([type=submit]):not([type=button]),textarea,select')&&visible(e))n++;if(e.shadowRoot)walk(e.shadowRoot);}};walk(document);return n;})()};
 }).catch(()=>null);
 // The thank-you can live inside an employer's embedded Greenhouse frame (Zipline 704); the host
 // check still uses the top page, which must be the posting's own site.
 const embedded=f=>{try{return /^(?:job-)?boards\.greenhouse\.io$/.test(new URL(f.url()).hostname);}catch{return false;}};
 const main=typeof page.mainFrame==='function'?page.mainFrame():page;
 const frames=typeof page.frames==='function'?[main,...page.frames().filter(f=>f!==main&&embedded(f))]:[page];
 let evidence=null;
 for(const frame of frames){
  const view=await read(frame);if(!view)continue;
  evidence=webpageAcceptance({...view,url:page.url(),submittedFromUrl,job,submittedAt});
  if(evidence)break;
 }
 if(!evidence)return null;
 const req=(String(job.url).match(/_(JR?\d+[\w-]*)/i)||[])[1]?.replace(/-\d+$/,'');
 if(evidence.quote==='Application Under Review')evidence.requisition=req;
 if(screenshotPath){const bytes=await page.screenshot({type:'png',fullPage:true});await writeFile(screenshotPath,bytes,{mode:0o600});evidence.screenshotPath=screenshotPath;evidence.screenshotSha256=hash(bytes);}
 return evidence;
}

export async function waitForWebpageAcceptance(page,job,options={}) {
 const deadline=Date.now()+(options.timeoutMs??10000);
 do {const evidence=await collectWebpageAcceptance(page,job,options);if(evidence)return evidence;if(Date.now()>=deadline)return null;await new Promise(r=>setTimeout(r,400));}while(true);
}

// The opposite outcome: Submit left the applicant on the same form with visible field errors,
// so the employer did not accept it. Only a page that still shows its submit control and at
// least one concrete error message counts; a silent unchanged page stays unresolved.
const errorText=/\b(?:required|is invalid|please (?:enter|select|fill|complete|correct|provide|choose|answer)|must (?:be|contain|select|enter)|cannot be (?:blank|empty)|fix the errors?|errors? (?:found|below)|missing)\b/i;
const spamFlag=/\b(?:flagged as (?:possible |potential )?spam|(?:submission|application) (?:was |has been )?(?:blocked|rejected) as spam)\b/i;
const codeGate=/\b(?:enter (?:the |your )?(?:\d+-(?:character|digit) )?(?:security|verification) code|security code (?:was )?sent to)\b/i;
export function webpageRejection({url,submittedFromUrl,submitVisible=false,errors=[],alerts=[],invalid=[],text=''}={}) {
 if(!sameHost(url,submittedFromUrl))return null;
 // Ashby's anti-automation refusal and Greenhouse's emailed-code gate both leave nothing accepted.
 const body=String(text).replace(/\s+/g,' ');
 const spam=body.match(spamFlag);if(spam)return {source:'webpage',outcome:'flagged_spam',url,messages:[spam[0]],invalidFields:[]};
 const code=body.match(codeGate);if(code)return {source:'webpage',outcome:'verification_code',url,messages:[code[0]],invalidFields:[]};
 if(!submitVisible)return null;
 const messages=[...errors,...alerts].map(t=>String(t).replace(/\s+/g,' ').trim()).filter(t=>t&&errorText.test(t));
 const fields=[...new Set(invalid.map(t=>String(t).replace(/\s+/g,' ').trim()).filter(Boolean))];
 if(!messages.length&&!fields.length)return null;
 return {source:'webpage',outcome:'rejected',url,messages:[...new Set(messages)].slice(0,8).map(t=>t.slice(0,200)),invalidFields:fields.slice(0,12).map(t=>t.slice(0,120))};
}
// sameDocument: no page load happened since Submit. Only then can an empty required field be the browser's own
// validation blocking the POST; a fresh blank form loaded after a real submit must never read as a rejection.
export async function collectWebpageRejection(page,{submittedFromUrl,screenshotPath,sameDocument=true}={}) {
 const view=await page.evaluate(sameDocument=>{
  // Shadow roots too (SmartRecruiters draws its form, buttons and errors inside them), and the browser's own
  // required-field check: an empty required field blocks the POST and is highlighted without aria-invalid (lesson 435).
  const deep=(root,sel,out=[])=>{for(const el of root.querySelectorAll('*')){if(el.matches(sel))out.push(el);if(el.shadowRoot)deep(el.shadowRoot,sel,out);}return out;};
  const flat=n=>n.nodeType===3?n.textContent:n.tagName==='SLOT'?n.assignedNodes({flatten:true}).map(flat).join(''):[...(n.shadowRoot?.childNodes||[]),...(n.shadowRoot?[]:n.childNodes||[])].map(flat).join('');
  const text=e=>(e.innerText||flat(e)||'').replace(/\s+/g,' ').trim();
  const visible=e=>!!(e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
  const label=e=>(e.labels?.[0]?.innerText||e.getAttribute('aria-label')||e.closest('fieldset')?.querySelector('legend')?.innerText||e.name||'').trim()||(e.labels?.[0]?flat(e.labels[0]).trim():'');
  return {submitVisible:deep(document,'button,input[type="submit"],[role="button"]')
    .some(e=>visible(e)&&/^(?:submit(?: (?:my |your )?application)?|send(?: (?:my )?application)?|apply(?: now)?|complete(?: (?:my )?application)?|finish)$/i.test(text(e)||e.value||'')),
   errors:deep(document,'[data-automation-id="errorMessage"],.field-error,.validation-error,.error-message,.invalid-feedback,[id$="-error"],[class*="error" i]')
    .filter(e=>visible(e)&&e.children.length<4).map(text),
   alerts:deep(document,'[role="alert"],[aria-live="assertive"]').filter(visible).map(text),
   invalid:[...deep(document,'[aria-invalid="true"]'),...(sameDocument?deep(document,'input:invalid,select:invalid,textarea:invalid').filter(e=>e.required&&e.type!=='hidden'):[])].filter(visible).map(label),
   text:(document.body?.innerText||'').slice(0,20000)};
 },sameDocument).catch(()=>null);
 if(!view)return null;
 const rejection=webpageRejection({...view,url:page.url(),submittedFromUrl});
 if(rejection&&screenshotPath){const bytes=await page.screenshot({type:'png',fullPage:true});await writeFile(screenshotPath,bytes,{mode:0o600});rejection.screenshotPath=screenshotPath;}
 return rejection;
}

// In his own Finish-in-my-Chrome run he may press the employer's Submit himself. The step model then sees a page
// with no form and stops as if for a sign-in; the success page is read first so the run records it instead of
// waiting on a page that will never advance (Rivian iCIMS 12055, lesson 454).
const portalSubmitted=/\byou are currently submitted to this (?:job|position|posting)\b/i;
export function confirmationPageText(text='') {
 const body=String(text).replace(/\s+/g,' ').trim();
 if(blocked.test(body))return null;
 return (body.match(success)||body.match(portalSubmitted))?.[0]??null;
}
