import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {runWorker,snapshot} from '../src/dashboard-worker.mjs';
// RV Tech 13331 (Ashby): the form's "I certify ..." and "I understand my application will be processed in accordance
// with RV Tech's Candidate Privacy Policy." are lone checkbox groups whose required star is CSS on the heading's
// _required_ class, so the snapshot read them as optional. The step agent then sent acceptTerms on the privacy one and
// the account-page terms guard failed the run. Both are required application questions; since 2026-11-02 both are ticked automatically (lesson 431).
const entry=(path,heading,required)=>`<div data-field-path="${path}" data-field-entry-id="x_${path}"><fieldset class="ashby-application-form-input-checkbox-group"><label class="_heading_f7 ${required?'_required_f7 ':''}ashby-application-form-question-title" for="${path}">${heading}</label><div class="ashby-application-form-input-checkbox-group-option"><span><input type="checkbox" id="x_${path}-labeled-checkbox-0" name="Yes"></span><label for="x_${path}-labeled-checkbox-0">Yes</label></div></fieldset></div>`;
const form=`<form method="post" class="ashby-application-form-container"><div class="ashby-application-form-field-entry" data-field-entry-id="x_name"><label class="_heading_f7 _required_f7 ashby-application-form-question-title" for="n">Name</label><input id="n" name="n" type="text" required></div>${entry('cert','I certify the information provided in this application is true and correct to the best of my knowledge.',true)}${entry('priv','I understand my application will be processed in accordance with RV Tech’s Candidate Privacy Policy.',true)}${entry('news','I would like to receive newsletters.',false)}<button type="submit">Submit Application</button></form>`;
test('an Ashby lone attestation checkbox is required when its heading carries the required class',async()=>{
 const browser=await chromium.launch();try{const page=await browser.newPage();
  await page.route('http://localhost/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<html></html>'}));await page.goto('http://localhost/fixture');
  await page.setContent(form);
  const boxes=(await snapshot(page)).frames[0].controls.filter(c=>c.type==='checkbox');
  assert.deepEqual(boxes.map(c=>[c.label.slice(0,12),c.required]),[['I certify th',true],['I understand',true],['I would like',false]]);
 }finally{await browser.close();}
});
test('a required application-form attestation checkbox is ticked automatically, not refused as account terms',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ashby-attest-')),runDir=join(dir,'run'),stateRoot=join(dir,'state');await mkdir(runDir);await mkdir(stateRoot);
 let posts=0;const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');if(req.method==='POST'){posts++;return res.end('<h1>Thank you</h1>');}res.end(form);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 const profilePath=join(dir,'profile.json'),resumePath=join(dir,'resume.pdf');
 await writeFile(profilePath,JSON.stringify({answers:{fullName:'Fixture Applicant'},documents:{}}));await writeFile(resumePath,'x');
 await writeFile(join(runDir,'request.json'),JSON.stringify({job:{id:999913331,company:'Fixture',title:'Reliability Engineer',url},profilePath,resumePath,engine:'claude',model:'claude-opus-5-5',parkQuestions:true,autoSubmit:true}));
 const execImpl=async(_c,_a,prompt)=>{const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);
  const name=controls.find(c=>c.label==='Name'&&!c.value),box=controls.find(c=>c.type==='checkbox'&&/certify|processed in accordance|newsletters/.test(c.label)&&c.value!=='true'),submit=controls.find(c=>c.type==='submit');
  const action=name?{action:'fill',control:name.id,fact:'fullName'}:box?{action:'fill',control:box.id,fact:'acceptTerms'}:{action:'review',control:submit.id,fact:''};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{...action,message:''},usage:{}})};};
 try{
  await runWorker(runDir,{execImpl,stateRoot,allowLocalFixture:true});
  const state=JSON.parse(await readFile(join(runDir,'state.json'),'utf8'));
  assert.doesNotMatch(state.message??'',/Only a required terms checkbox/);
  // His rule of 2026-11-02 (lesson 431): every required single checkbox is ticked without asking, the truthfulness
  // attestation included, so the completed form is submitted once under the standing authorization.
  assert.equal(state.status,'completed',state.message);  // the page turned into "Thank you" (lesson 435)
  assert.equal(posts,1,'submitted once');
  assert.ok(!(state.questions??[]).length,'nothing went to him for approval');
  assert.ok(state.events.some(e=>/Ticked required checkbox: I certify/.test(e.message)),'the attestation was ticked');
  assert.ok(state.events.some(e=>/Ticked required checkbox: I understand/.test(e.message)),'the privacy consent was ticked');
  assert.ok(state.events.some(e=>/Left optional unanswered question blank: I would like/.test(e.message)),'the optional opt-in stayed blank');
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
