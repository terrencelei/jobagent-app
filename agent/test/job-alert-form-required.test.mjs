import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {requiredContacts} from '../src/required-contacts.mjs';
import {runWorker,atomic} from '../src/dashboard-worker.mjs';

const answers={firstName:'Fixture',lastName:'Applicant',email:'fixture@example.test',phone:'2025550100'};

test('required contact recovery accepts a "(required)" label marker (Waymo 13548)',()=>{
 const snap=c=>({frames:[{frameIndex:0,controls:[c]}]});
 const control={id:'c',label:'First Name (required)',type:'text',inForm:true,required:true,value:''};
 assert.equal(requiredContacts(snap(control),{answers})[0].value,'Fixture');
 assert.equal(requiredContacts(snap({...control,label:'Email (Required)',type:'email'}),{answers})[0].value,answers.email);
 assert.equal(requiredContacts(snap({...control,label:'Phone Number (required)',type:'tel'}),{answers})[0].value,answers.phone);
 assert.equal(requiredContacts(snap({...control,label:'Describe your first name (required)'}),{answers}).length,0);
});

// Waymo's posting page (13548) carries a job-alert signup form above the application form. Both have
// required First Name / Last Name / Email inputs. Only the application form, the one holding Submit,
// is validated and sent by the browser, so its empty contacts are filled and the alert form is ignored.
test('a job-alert form beside the application form does not block review (Waymo 13548)',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'job-alert-form-')),run=join(dir,'run');await mkdir(run);
 let posts=0,reads=0;
 const contact=(prefix,i,label,type)=>`<label for="${prefix}${i}">${label} <span>(required)</span></label><input id="${prefix}${i}" type="${type}" required>`;
 const server=createServer((req,res)=>{
  if(req.method==='POST')posts++;
  res.setHeader('Content-Type','text/html');
  res.end(`<form id="alerts" method="post" action="/alerts"><h2>Sign up for job alerts</h2>${contact('a',0,'First Name','text')}${contact('a',1,'Last Name','text')}${contact('a',2,'Email','email')}<label for="a3">Departments</label><input id="a3" type="text"><button type="submit">Subscribe</button></form>
<form id="apply" method="post" action="/apply"><h2>Apply</h2>${contact('b',0,'First Name','text')}${contact('b',1,'Last Name','text')}${contact('b',2,'Email','email')}${contact('b',3,'Phone Number','tel')}<button type="submit">Submit your application</button></form>`);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await writeFile(profile,JSON.stringify({answers}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:9913548,company:'Fixture',title:'Diagnostics Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,maxSteps:4});
 const execImpl=async(_command,_args,prompt)=>{
  reads++;const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);
  const target=controls.find(c=>c.type==='submit'&&/Submit your application/.test(c.label));
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:'review',control:target.id,fact:'',message:''},usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,'ready_to_submit',state.message);
  assert.equal(posts,0);assert.equal(Boolean(state.submission_attempted),false);
  assert.ok(state.events.some(e=>e.message==='Filled saved required contact details before review'));
  for(const value of Object.values(answers))assert.ok(state.review.answers.some(a=>a.value===value),value);
  // Exactly one set of contact answers: the application form's, never the job-alert form's.
  assert.equal(state.review.answers.filter(a=>a.value===answers.email).length,1);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
