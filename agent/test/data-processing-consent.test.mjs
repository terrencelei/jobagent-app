import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {runWorker,snapshot,uploadDocument} from '../src/dashboard-worker.mjs';
import {recruitingDataConsentText,requiredRecruitingConsent} from '../src/data-consent.mjs';
// His standing rule of 2026-11-01 ("Yes, always"): a REQUIRED in-form consent to processing his personal data for the
// application is ticked without asking; marketing/newsletter/talent-community/job-alert/SMS opt-ins and optional boxes never are.
const PRIVACY='I hereby consent to the processing of my personal data for the purpose of managing my job application, assessing my suitability for the job role applied for and so that Genentech can communicate with me about my application and other suitable roles. Further information can be found in the attached Privacy Notice.';
const MARKETING='I would like to receive company updates, news about career opportunities, and relevant information from Genentech. For this purpose I consent to the processing of my personal data.';
const SMS='By ticking the box, I consent to receive calls, SMS/text messages, and voice messages from Genentech regarding employment opportunities.';
test('recruiting data-processing consent text is recognised; opt-ins and attestations are not',()=>{
 assert.equal(recruitingDataConsentText(PRIVACY),true);
 assert.equal(recruitingDataConsentText('I understand my application will be processed in accordance with RV Tech’s Candidate Privacy Policy.'),true);
 for(const t of [MARKETING,SMS,'I consent to the processing of my personal data to join the Talent Community and receive job alerts.','Sign me up for the newsletter (I agree to the privacy policy).','I certify the information provided in this application is true and correct.','I agree to receive text messages about my application.'])assert.equal(recruitingDataConsentText(t),false,t);
});
test('only a required in-form checkbox qualifies',()=>{
 const box={type:'checkbox',label:PRIVACY,inForm:true};
 assert.equal(requiredRecruitingConsent({...box,required:true}),true);
 assert.equal(requiredRecruitingConsent({...box,required:false}),false,'optional consent is not ticked');
 assert.equal(requiredRecruitingConsent({...box,required:true,inForm:false}),false);
 assert.equal(requiredRecruitingConsent({...box,required:true,type:'radio'}),false);
 assert.equal(requiredRecruitingConsent({type:'checkbox',label:'Marketing preferences',optionLabel:PRIVACY,required:true,inForm:true}),false,'a marketing group heading vetoes the box');
});
// Phenom (Genentech 14640) markup, trimmed: the consent fieldset is titled with the schema key "disclaimerUSA" and the
// resume input is an unlabelled display:none input beside an "Upload Resume" button.
const phenom=(required)=>`<div class="cloud-options" role="group" aria-labelledby="sr"><span id="sr" class="sr-only">Upload options</span><div class="resume-upload-wrapper"><input type="file" autocomplete="off" tabindex="-1" style="display: none;"><button type="button" class="upload-resume-btn">Upload Resume</button></div></div>
<form><label for="fn">First Name*</label><input id="fn" required>
<fieldset id="consentUSA" aria-labelledby="t"><legend id="t">disclaimerUSA</legend>
<div class="checkbox"><label><input type="checkbox" id="consentUSA.privacyNote" aria-required="${required}"><span><p>${PRIVACY}</p></span></label></div>
<div class="checkbox"><label><input type="checkbox" id="consentUSA.smsOptIn" aria-required="${required}"><span><p>${MARKETING}</p></span></label></div>
<div class="checkbox"><label><input type="checkbox" id="consentUSA.smsOptInOne" aria-required="${required}"><span>${SMS}</span></label></div>
</fieldset><button type="submit">Next</button></form>`;
test('Phenom: the consent boxes carry their own text and the hidden input is the resume upload',async()=>{
 const browser=await chromium.launch();try{const page=await browser.newPage();
  await page.route('http://localhost/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<html></html>'}));await page.goto('http://localhost/fixture');await page.setContent(phenom(false));
  const controls=(await snapshot(page)).frames[0].controls;
  const boxes=controls.filter(c=>c.type==='checkbox');
  assert.deepEqual(boxes.map(c=>c.label.slice(0,14)),['I hereby conse','I would like t','By ticking the']);
  assert.ok(boxes.every(c=>!c.required),'Phenom marks these aria-required=false; they stay optional');
  const file=controls.find(c=>c.type==='file');
  assert.match(file.label,/^Upload Resume/);
  assert.equal(uploadDocument(file.label,'r.pdf')?.kind,'resume');
 }finally{await browser.close();}
});
async function run(required,decide){
 const dir=await mkdtemp(join(tmpdir(),'consent-')),runDir=join(dir,'run'),stateRoot=join(dir,'state');await mkdir(runDir);await mkdir(stateRoot);
 let posts=0;const body=phenom(required).replace(/<div class="cloud-options"[\s\S]*?<\/div><\/div>/,'');
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');if(req.method==='POST'){posts++;return res.end('<h1>Thank you</h1>');}res.end(`<html><body>${body}</body></html>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 const profilePath=join(dir,'profile.json'),resumePath=join(dir,'resume.pdf');
 await writeFile(profilePath,JSON.stringify({answers:{firstName:'Fixture'},documents:{}}));await writeFile(resumePath,'x');
 await writeFile(join(runDir,'request.json'),JSON.stringify({job:{id:999914640,company:'Fixture',title:'ML Engineer',url},profilePath,resumePath,engine:'claude',model:'claude-opus-5-5',parkQuestions:true,autoSubmit:false}));
 const seen=new Set();
 const execImpl=async(_c,_a,prompt)=>{const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);
  const action=decide(controls,seen);
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{...action,message:''},usage:{}})};};
 try{await runWorker(runDir,{execImpl,stateRoot,allowLocalFixture:true});return {state:JSON.parse(await readFile(join(runDir,'state.json'),'utf8')),posts};}
 finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
}
// The model offers every unticked box once (acceptTerms), then reviews.
const offerAll=(controls,seen)=>{const fn=controls.find(c=>c.label==='First Name*'&&!c.value);if(fn)return {action:'fill',control:fn.id,fact:'firstName'};
 const box=controls.find(c=>c.type==='checkbox'&&c.value!=='true'&&!seen.has(c.label));if(box){seen.add(box.label);return {action:'fill',control:box.id,fact:'acceptTerms'};}
 return {action:'review',control:controls.find(c=>c.type==='submit').id,fact:''};};
test('a required data-processing consent is ticked; marketing and SMS opt-ins are not',async()=>{
 const {state,posts}=await run(true,offerAll);
 assert.equal(posts,0,'nothing was submitted');
 const ticked=state.events.filter(e=>/Ticked required (?:data-processing consent|checkbox)/.test(e.message)).map(e=>e.message);
 assert.equal(ticked.length,1,JSON.stringify(state.events.map(e=>e.message)));
 assert.match(ticked[0],/I hereby consent/);
 assert.ok(!state.events.some(e=>/consent: (I would like|By ticking)/.test(e.message)),'opt-ins were not ticked');
 assert.ok(!(state.questions??[]).some(q=>/I hereby consent/.test(q.label)),'the privacy consent was not sent for approval');
});
test('an optional data-processing consent is not ticked',async()=>{
 const {state,posts}=await run(false,offerAll);
 assert.equal(posts,0);
 assert.ok(!state.events.some(e=>/Ticked required data-processing consent|Accepted required terms/.test(e.message)),JSON.stringify(state.events.map(e=>e.message)));
});
import {guardDialogs} from '../src/dialog-guard.mjs';
test('a dismissed page alert reaches the worker (Phenom reports a missing resume only in an alert)',async()=>{
 let handler;const context={on:(_e,h)=>{handler=h;}};const seen=[];let dismissed=0;
 guardDialogs(context,m=>seen.push(m));
 await handler({type:()=>'alert',message:()=>'Please upload your resume',dismiss:async()=>{dismissed++;},accept:async()=>{}});
 assert.deepEqual(seen,['Please upload your resume']);assert.equal(dismissed,1);
});

test('in an application, a required "agree to the privacy notice" box is consent even without the word application (lesson 427)',async()=>{
 const {requiredRecruitingConsent}=await import('../src/data-consent.mjs');
 const box={type:'checkbox',required:true,inForm:true,label:'You declare that you have read and agree to the privacy notice of Intuitive.*'};
 assert.equal(requiredRecruitingConsent(box),false);
 assert.equal(requiredRecruitingConsent(box,{applicationContext:true}),true);
 assert.equal(requiredRecruitingConsent({...box,required:false},{applicationContext:true}),false);
 assert.equal(requiredRecruitingConsent({...box,label:'I agree to the privacy notice and to receive marketing emails'},{applicationContext:true}),false);
});
test('a box whose caption says you must agree to the privacy statement is required (Kratos 14919)',()=>{
 const label='I agree to the privacy statement (In order to create your account and go to the next step, you must agree to the privacy statement.)';
 assert.equal(requiredRecruitingConsent({type:'checkbox',label,inForm:true},{applicationContext:true}),true);
 assert.equal(requiredRecruitingConsent({type:'checkbox',label:'I agree to the privacy statement',inForm:true},{applicationContext:true}),false);
 assert.equal(requiredRecruitingConsent({type:'checkbox',label:'Send me job alerts; you must agree to the privacy statement',inForm:true},{applicationContext:true}),false);
});
