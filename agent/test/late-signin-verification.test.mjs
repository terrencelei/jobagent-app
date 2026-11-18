import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runWorker,atomic} from '../src/dashboard-worker.mjs';

for(const trusted of [true,false])test(`Oracle gate appearing during decision uses bridge before human park: trusted=${trusted}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'oracle-late-')),run=join(dir,'run');await mkdir(run);
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');
 await writeFile(profile,JSON.stringify({answers:{email:'fixture@example.com',firstName:'Fixture'}}));await writeFile(resume,'fixture');
 const url='https://efds.fa.em5.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/123/apply/email';
 await atomic(join(run,'request.json'),{job:{id:trusted?99113711:99113712,company:'Ford Motor Company',title:'Fixture Engineer',url},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,autoSubmit:false,headlessOnly:true,maxSteps:6});
 let page,posts=0,loads=0,lookups=0,decisions=0,verifyClicks=0;
 const launch=chromium.launch;
 chromium.launch=async function(options){
  assert.equal(options.headless,true);
  const browser=await launch.call(this,options),newContext=browser.newContext.bind(browser);
  browser.newContext=async options=>{
   const context=await newContext(options),newPage=context.newPage.bind(context);
   context.newPage=async()=>{
    page=await newPage();await page.exposeFunction('verified',()=>verifyClicks++);
    await page.route('**/*',route=>{if(route.request().method()==='POST')posts++;loads++;return route.fulfill({contentType:'text/html',body:'<main><a href="#job">Back to Job Details</a></main>'});});return page;
   };return context;
  };return browser;
 };
 const execImpl=async(_cmd,_args,prompt)=>{
  if(!prompt.startsWith('{')){
   lookups++;assert.match(prompt,/full-message read tool/);
   return {code:0,stdout:JSON.stringify({result:JSON.stringify({messageId:'abcdef1234567890',receivedAt:new Date().toISOString(),sender:trusted?'recruitingnoreply@ford.com':'other@example.com',recipients:['fixture@example.com'],subject:'Confirm your identity',body:'<img src="https://efds.fa.em5.oraclecloud.com/hcmUI/CandidateExperience/images?imageId=fixture">We need you to confirm your identity for your job application for using this code: 123456. This code expires in 10 minutes.'})})};
  }
  decisions++;const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);let action;
  if(decisions<=2){
   await page.evaluate(n=>{document.querySelector('main').innerHTML='<label>Email Address<input type="email"></label>'+(n===2?'<label>Applicant Privacy Notice<input type="checkbox"></label>':'');},decisions);
   action={action:'human',message:'Application controls rendered after snapshot.'};
  }else if(decisions===3){
   // Posting and email-form renders consumed both same-URL field refreshes.
   assert.equal(controls.some(c=>c.type==='checkbox'),true);
   await page.evaluate(()=>{document.querySelector('main').innerHTML='<h1>Confirm Your Identity</h1><p>The verification code was sent to this email address: fixture@example.com</p>'+ '<input maxlength="1">'.repeat(6)+'<button type="button" onclick="if([...document.querySelectorAll(\'input\')].map(x=>x.value).join(\'\')===\'123456\'){verified();document.querySelector(\'main\').innerHTML=\'<h1>Candidate Application</h1><form><label>First Name<input required></label><button type=submit>Submit application</button></form>\'}">VERIFY</button>';});
   action={action:'human',message:'Screenshot shows Confirm Your Identity six-code gate, missing from supplied controls.'};
  }else{
   const field=controls.find(c=>c.label==='First Name');assert.ok(field,'next decision sees candidate form');
   action=!field.value?{action:'fill',control:field.id,fact:'firstName'}:{action:'review',control:controls.find(c=>c.type==='submit').id};
  }
  return {code:0,stdout:JSON.stringify({structured_output:{control:'',fact:'',message:'',...action},usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,trusted?'ready_to_submit':'needs_human',state.message);
  assert.equal(lookups,trusted?1:3);assert.equal(verifyClicks,trusted?1:0);
  assert.equal(posts,0);assert.equal(loads,1);assert.notEqual(state.submitted,true);assert.notEqual(state.submission_attempted,true);
  assert.equal(state.events.some(e=>/Completed email verification/.test(e.message)),trusted);
 }finally{chromium.launch=launch;await rm(dir,{recursive:true,force:true});}
});
