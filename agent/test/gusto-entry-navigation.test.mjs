import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {safeNavigation,isApplicationEntry,isFinalControl,runWorker,atomic} from '../src/dashboard-worker.mjs';

const title='Mechanical Engineer';
test('role-specific Apply labels require the exact job title and preserve final-control checks',()=>{
 const job={title};
 for(const label of ['Apply for Mechanical Engineer',' Apply for  Mechanical Engineer » ']){
  const entry={label,type:'submit',formFields:0};
  assert.equal(safeNavigation(label,job),true);
  assert.equal(isApplicationEntry(entry,[],job),true);
  assert.equal(isFinalControl(entry,[],job),false);
  assert.equal(isApplicationEntry({...entry,formFields:1},[],job),false);
  assert.equal(isFinalControl({...entry,formFields:1},[],job),true);
  assert.equal(isApplicationEntry(entry,[{label:'Name',value:'Fixture'}],job),false);
  assert.equal(isFinalControl(entry,[{label:'Name',value:'Fixture'}],job),true);
 }
 for(const label of ['Apply for Mechanical Engineer and subscribe','Apply for Electrical Engineer','Apply for Mechanical Engineer II'])assert.equal(safeNavigation(label,job),false);
 assert.equal(safeNavigation('Apply for Mechanical Engineer'),false);
});

for(const tag of ['a','button'])test(`Gusto-style ${tag} opens the form and stops at review without submitting`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'gusto-entry-'));
 let formLoads=0,submits=0;
 const server=createServer((req,res)=>{
  res.setHeader('Content-Type','text/html');
  if(req.method==='POST'){submits++;return res.end('Application received');}
  if(req.url==='/form'){formLoads++;return res.end(`<form method="post" action="/submit"><label>Name<input required name="name"></label><button type="submit">Apply for ${title}</button></form>`);}
  res.end(`<h1>${title}</h1>${tag==='a'?`<a href="/form">Apply for ${title}</a>`:`<button onclick="location.href='/form'">Apply for ${title}</button>`}`);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const run=join(dir,'run'),profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await mkdir(run);
 await writeFile(profile,JSON.stringify({answers:{fullName:'Fixture Applicant'}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:tag==='a'?991481:991482,company:'Fixture Gusto',title,url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,maxSteps:4});
 const execImpl=async(_c,_a,prompt)=>{
  const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);
  const field=controls.find(c=>c.type==='text'&&!c.value),target=field??controls.find(c=>c.label===`Apply for ${title}`);
  // Some step agents choose review even at the entry control; entry classification must handle it.
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:field?'fill':tag==='a'&&!target.formFields?'click':'review',control:target.id,fact:field?'fullName':'',message:''},usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,'ready_to_submit',state.message);
  assert.equal(formLoads,1);assert.equal(submits,0);
  assert.equal(state.review.submit_label,`Apply for ${title}`);
  assert.ok(state.events.some(e=>e.message===`Opened: Apply for ${title}`));
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
