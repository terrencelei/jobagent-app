import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {snapshot,runWorker,atomic} from '../src/dashboard-worker.mjs';

// ArcBest 12717 (Avature) Disclosures page: two single-option radios whose question label "Please Confirm: *"
// is the <label for> of the radio itself, with the option text beside it and no required attribute.
const page=`<form method="post">
<div class="question"><label for="q1">Please Confirm: <span class="req">*</span></label>
 <div class="option"><input type="radio" id="q1" name="q1" value="1"><label>I hereby provide my authorization.</label></div></div>
<div class="question"><label for="name">Your Name: *</label><input id="name" name="name" required></div>
<div class="question"><label for="q2">Please Confirm: <span class="req">*</span></label>
 <div class="option"><input type="radio" id="q2" name="q2" value="1"><span>I acknowledge that I have accessed this online application portal by logging in via a secure email address using my own secretly chosen password.</span></div></div>
<fieldset><legend>Do you live with a disability? *</legend><label><input type="radio" name="dis" value="y">Yes</label><label><input type="radio" name="dis" value="n">No</label></fieldset>
<button type="submit">Submit</button></form>`;

test('a lone radio is named by its question and option text and its star makes it required',async()=>{
 const browser=await chromium.launch();
 try{
  const p=await browser.newPage();
  await p.route('https://jobs.example.com/**',r=>r.fulfill({contentType:'text/html',body:page}));
  await p.goto('https://jobs.example.com/apply');
  const controls=(await snapshot(p)).frames[0].controls;
  const radios=controls.filter(c=>c.type==='radio');
  assert.deepEqual(radios.filter(c=>/Please Confirm/.test(c.label)).map(c=>[c.label,c.required,c.optionLabel]),[
   ['Please Confirm: * I hereby provide my authorization.',true,undefined],
   ['Please Confirm: * I acknowledge that I have accessed this online application portal by logging in via a secure email address using my own secretly chosen password.',true,undefined],
  ]);
  // A real group keeps its question/option split.
  assert.deepEqual(radios.filter(c=>c.name==='dis').map(c=>[c.label,c.optionLabel]),[['Do you live with a disability? *','Yes'],['Do you live with a disability? *','No']]);
 }finally{await browser.close();}
});

test('both attestations are flagged for approval instead of being skipped as optional and submitted',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'avature-radio-')),run=join(dir,'run');await mkdir(run);
 let posts=0;
 const server=createServer((req,res)=>{if(req.method==='POST'){posts++;return res.end('posted');}res.setHeader('Content-Type','text/html');res.end(page);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');
 await writeFile(profile,JSON.stringify({answers:{email:'fixture@example.test',firstName:'Fixture',lastName:'Applicant',fullName:'Fixture Applicant',disabilityStatus:'No'}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:9912717,company:'Fixture ArcBest',title:'Test and Reliability Engineer I',url:`http://127.0.0.1:${server.address().port}/careersmarketplace/ApplicationGeneral?jobId=29813`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,autoSubmit:true,maxSteps:12});
 const execImpl=async(_c,_a,prompt)=>{
  const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);
  const confirm=controls.find(c=>c.type==='radio'&&/Please Confirm/.test(c.label)&&c.value!=='true');
  const name=controls.find(c=>c.label==='Your Name: *'&&!c.value);
  const dis=controls.find(c=>c.optionLabel==='No'&&c.value!=='true');
  const submit=controls.find(c=>c.label==='Submit');
  const action=name?{action:'fill',control:name.id,fact:'fullName'}:dis?{action:'fill',control:dis.id,fact:'disabilityStatus'}:confirm?{action:'fill',control:confirm.id,fact:'acknowledge'}:{action:'review',control:submit.id};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{fact:'',message:'',...action},usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));const messages=state.events.map(e=>e.message);
  assert.equal(messages.some(m=>/Left optional unanswered question blank: Please Confirm/.test(m)),false,JSON.stringify(messages));
  assert.deepEqual((state.questions??[]).map(q=>[q.label,q.required]).sort(),[
   ['Please Confirm: * I acknowledge that I have accessed this online application portal by logging in via a secure email address using my own secretly chosen password.',true],
   ['Please Confirm: * I hereby provide my authorization.',true],
  ],JSON.stringify(state));
  assert.equal(posts,0);assert.equal(Boolean(state.submission_attempted),false);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
