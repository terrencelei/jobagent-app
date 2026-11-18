import test from 'node:test';import assert from 'node:assert/strict';
import {currentEmployerAnswer,currentEmployerCorrection,currentEmployerFacts} from '../src/current-employer.mjs';
import {approvedValue} from '../src/dashboard-worker.mjs';
import {profileFact} from '../src/profile-facts.mjs';

// His instruction (2026-10-23): no current employer. IGEL's open row and résumé parsers must not imply one.
const profile={answers:{noCurrentEmployer:true},workHistory:[{company:'IGEL Technology',title:'Financial Analyst Intern',from:['6','2023'],to:null}]};
const fill={action:'fill',fact:'currentEmployer'};

test('current company and title stay blank when optional and are N/A when required',()=>{
 assert.deepEqual(currentEmployerFacts(profile),{});
 for(const label of ['Current company','Current Company*','Current title','Current or most recent employer']){
  assert.equal(currentEmployerAnswer(label,profile).value,'N/A');
  assert.equal(approvedValue(fill,{label,type:'text',required:false},profile,{},new Map()),'');
  assert.equal(approvedValue(fill,{label,type:'text',required:true},profile,{},new Map()),'N/A');
 }
});

test('a parser-prefilled current company is cleared, or set to N/A when required',()=>{
 const snap=c=>({url:'https://jobs.lever.co/x/1',frames:[{controls:[{id:'c1',label:'Current company',type:'text',inForm:true,...c}]}]});
 assert.equal(currentEmployerCorrection(snap({value:'Genentech',required:false}),profile)?.control.id,'c1');
 assert.equal(currentEmployerCorrection(snap({value:'Genentech',required:true}),profile)?.control.id,'c1');
 assert.equal(currentEmployerCorrection(snap({value:'N/A',required:true}),profile),null);
});

test('employment questions say not employed',()=>{
 assert.equal(profileFact('Which company are you currently employed with?',profile.answers,{history:profile.workHistory}).value,'N/A');
 assert.equal(profileFact('Are you currently employed? If yes, may we speak to your present employer?',{...profile.answers,mayContactCurrentEmployer:'Yes'},{history:profile.workHistory,options:['Yes','No']}).value,'No');
});

test('old saved answers naming IGEL as his employer are overruled',()=>{
 const bank={'which company are you currently employed with?':{question:'Which company are you currently employed with?',answer:'IGEL Technology',approvedAt:'2026-10-01T00:00:00Z'}};
 assert.equal(approvedValue({action:'fill',fact:'bank'},{label:'Which company are you currently employed with?',type:'text',required:true},profile,bank,new Map()),'N/A');
 assert.equal(profileFact('Are you currently employed? If yes, may we speak to your present employer?',profile.answers,{history:profile.workHistory,options:['Currently employed, you may contact my current employer','Currently employed, do not contact','Not currently employed']}).value,'Not currently employed');
});

test('a current company the resume parser fills in late is cleared at the final check, not handed over (Humble Robotics)',async()=>{
 const {runWorker,atomic}=await import('../src/dashboard-worker.mjs');
 const {mkdtemp,mkdir,writeFile,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {createServer}=await import('node:http');
 const dir=await mkdtemp(join(tmpdir(),'late-parser-')),run=join(dir,'run');await mkdir(run);let posted=false;
 // Lever's parser writes the sponsor into Current company a moment after the page is read.
 const server=createServer((req,res)=>{if(req.method==='POST')posted=true;res.setHeader('Content-Type','text/html');
  res.end('<form method="post"><label for="cc">Current company</label><input id="cc" name="cc"><button type="submit">Submit application</button></form><script>setTimeout(()=>{document.getElementById("cc").value="Genentech"},400)</script>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profilePath=join(dir,'profile.json'),resume=join(dir,'resume.pdf');
 await writeFile(profilePath,JSON.stringify({answers:{noCurrentEmployer:true},projects:[{sponsor:'Helix Bio (Formulation Sciences)'}]}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:985,company:'Fixture',url:`http://127.0.0.1:${server.address().port}/apply`},profilePath,resumePath:resume,engine:'claude',parkQuestions:true});
 let reads=0;
 const execImpl=async(_c,_a,prompt)=>{reads++;const controls=JSON.parse(prompt).page.frames[0].controls;const submit=controls.find(c=>/Submit/.test(c.label));
  if(reads===1)await new Promise(r=>setTimeout(r,800));  // the parser fills the box while the agent decides
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:'review',control:submit.id,fact:'',message:''},usage:{}})};};
 try{
  await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.doesNotMatch(String(state.message),/project sponsor/);assert.equal(state.status,'ready_to_submit',state.message);
  assert.equal((state.review?.answers??[]).find(a=>a.label==='Current company')?.value??'','');assert.equal(posted,false);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('"notified your current manager" is answered from having no employer, not by a model',()=>{
 const q='Have you notified your current manager that you are applying to this requisition?';
 assert.equal(profileFact(q,profile.answers,{history:profile.workHistory,options:['Yes','No']}).value,'No');
 assert.equal(profileFact(q,profile.answers,{history:profile.workHistory,options:['Yes','No','N/A']}).value,'N/A');
 assert.equal(profileFact(q,profile.answers,{history:profile.workHistory}).value,'No');
});
