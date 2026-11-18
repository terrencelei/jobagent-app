import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {snapshot,runWorker,atomic} from '../src/dashboard-worker.mjs';
import {termsCheckbox} from '../src/accounts.mjs';
import {preferenceAnswer} from '../src/applicant-preferences.mjs';
import {equivalentOption} from '../src/settled-facts.mjs';

// X-Bow 12727 (ApplicantPro): the registration page's privacy-policy checkbox has no <label>; its caption is a sibling
// <span> ending in "*" and the page's script refuses the form without it. The snapshot named it "info_use_consent",
// required false, and the account-page terms guard failed the run.
const REGISTRATION=`<h2>Create a Job Profile</h2><p>* Fields Are Required</p><form id="apply" method="post" action="/account/">
 <label for="email" class="sr-only">Email*</label><input type="email" id="email" name="email" class="required" placeholder="Email*">
 <label for="password" class="sr-only">Password*</label><input type="password" id="password" name="password" class="required" placeholder="Password*">
 <div class="form-group"><div class="check-group col-sm-12"><input type="checkbox" id="info_use_consent" name="info_use_consent" class="v">
 <span class="bold">I agree to isolved Talent Acquisition's <a href="#">Applicant Information Use &amp; Privacy Policy</a>.*</span></div></div>
 <div class="check-group"><input type="checkbox" id="job_alerts" name="job_alerts"> <span>Send me job alerts</span></div>
 <input type="submit" id="submit_apply" value="Create Job Profile"></form>`;

test('a checkbox captioned by a sibling span is labelled by that caption and its trailing * makes it required',async()=>{
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();
  await page.route('https://employer.applicantpro.com/account/',r=>r.fulfill({contentType:'text/html',body:REGISTRATION}));
  await page.goto('https://employer.applicantpro.com/account/');
  const controls=(await snapshot(page)).frames.flatMap(f=>f.controls);
  const consent=controls.find(c=>c.domId==='info_use_consent');
  assert.equal(consent.label,"I agree to isolved Talent Acquisition's Applicant Information Use & Privacy Policy.*");
  assert.equal(consent.required,true);
  assert.ok(termsCheckbox(consent.label));
  const alerts=controls.find(c=>c.domId==='job_alerts');
  assert.equal(alerts.label,'Send me job alerts');
  assert.equal(alerts.required,false);
  assert.ok(!termsCheckbox(alerts.label),'an opt-in beside the terms box is still not a terms checkbox');
 }finally{await browser.close();}
});

test('the account-page terms guard accepts the captioned required privacy-policy checkbox',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'applicantpro-consent-')),run=join(dir,'run'),root=join(dir,'account');
 await mkdir(run);await mkdir(join(root,'private'),{recursive:true});
 let posts=0;
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');if(req.method==='POST'){posts++;return res.end('posted');}if(req.url==='/favicon.ico')return res.end();res.end(REGISTRATION);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');
 await writeFile(profile,JSON.stringify({answers:{email:'fixture@example.test',firstName:'Fixture'}}));await writeFile(resume,'fixture');
 await writeFile(join(root,'private','credentials.json'),JSON.stringify({fixture:{host:'127.0.0.1',email:'fixture@example.test',password:'synthetic-local-only'}}));
 await atomic(join(run,'request.json'),{job:{id:9912727,company:'Fixture ApplicantPro',title:'Engineer',url:`http://127.0.0.1:${server.address().port}/account/`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,autoSubmit:false,maxSteps:4});
 let accepted=false;
 const execImpl=async(_c,_a,prompt)=>{
  const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);
  const consent=controls.find(c=>c.domId==='info_use_consent');
  const action=consent&&!accepted?(accepted=true,{action:'fill',control:consent.id,fact:'acceptTerms'}):{action:'human',message:'fixture stop after the terms checkbox'};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{fact:'',message:'',...action},usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,accountRoot:root,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  const messages=state.events.map(e=>e.message);
  assert.ok(messages.some(m=>/^Accepted required terms: I agree to isolved Talent Acquisition's Applicant Information Use & Privacy Policy/.test(m)),JSON.stringify(messages));
  assert.ok(!messages.some(m=>/Only a required terms checkbox/.test(m)),JSON.stringify(messages));
  assert.equal(posts,0);assert.equal(Boolean(state.submission_attempted),false);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('ApplicantPro "Applicant Communication Policy" select takes his saved SMS consent',()=>{
 const label="Please indicate if you agree to isolved Talent Acquisition's Applicant Communication Policy.";
 const options=['','Yes, I agree to be contacted by text messages','No, I do not agree to receive text messages'];
 assert.equal(preferenceAnswer(label,{recruitmentSmsConsent:'Yes'},{options})?.value,'Yes');
 assert.equal(preferenceAnswer(label,{recruitmentSmsConsent:'No'},{options:options.map(o=>({label:o,value:o}))})?.value,'No');
 assert.equal(preferenceAnswer(label,{recruitmentMessageConsent:'Yes'},{options}),null,'only the SMS consent answers a text-message policy');
 assert.equal(preferenceAnswer(label,{recruitmentSmsConsent:'Yes'},{options:['Yes','No']}),null,'without text-message options the policy is unknown');
 assert.equal(equivalentOption(label,'Yes',options,{recruitmentSmsConsent:'Yes'}),options[1]);
 assert.equal(equivalentOption(label,'No',options,{recruitmentSmsConsent:'No'}),options[2]);
 assert.equal(equivalentOption('Do you consent to be contacted?','Yes',['Yes, I consent','No, I do not consent'],{}),'Yes, I consent','the earlier wording still matches');
});
