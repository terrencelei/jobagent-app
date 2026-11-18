import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {regionalAnswer} from '../src/location-policy.mjs';
import {approvedValue,resolveKnownQuestion,runWorker} from '../src/dashboard-worker.mjs';

const label='Please provide your permanent address (city, state, zip code). We use this information to determine eligibility for relocation assistance for the internship. A permanent address is your long-term, stable home base used for legal identity, government records, and official mail.*';
const profile={answers:{applicationLocationRule:{defaultRegion:'bayArea',bayArea:{city:'Fixture City',address:{addressCity:'Fixture City',addressState:'CA',addressZip:'00000'}}}}};
const job={location:'San Jose, CA'};
const expected='Fixture City, CA 00000';

test('compound address requires all requested components and overrides partial ZIP facts',()=>{
 const question={label,type:'text',required:true};
 assert.equal(regionalAnswer(label,profile,job)?.value,expected);
 assert.equal(approvedValue({fact:'addressZip'},question,profile,{},new Map(),'Fixture',job),expected);
 assert.equal(resolveKnownQuestion({question,profile,job}).value,expected);
 const missing={answers:{applicationLocationRule:{defaultRegion:'bayArea',bayArea:{city:'Fixture City'}}}};
 assert.equal(resolveKnownQuestion({question,profile:missing,job}).resolved,false);
 assert.throws(()=>approvedValue({fact:'addressCity'},question,missing,{},new Map(),'Fixture',job),/confirmed answer/);
 assert.equal(regionalAnswer('Permanent address',profile,job)?.value,undefined);
 assert.equal(regionalAnswer('Previous employer address (city, state, zip code)',profile,job),undefined);
 assert.equal(regionalAnswer('Why do you want to relocate to this city, state, zip code?',profile,job),undefined);
});

test('worker fills a compound address once and reaches review without submission',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'compound-address-')),run=join(dir,'run');await mkdir(run);
 let submits=0,reads=0;
 const server=createServer((req,res)=>{if(req.url==='/submit')submits++;res.setHeader('Content-Type','text/html');res.end(`<form action="/submit"><label>${label}<input name="address" required></label><button type="submit">Submit application</button></form>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 await writeFile(join(dir,'profile.json'),JSON.stringify(profile));await writeFile(join(dir,'resume.pdf'),'fixture');
 await writeFile(join(run,'request.json'),JSON.stringify({job:{...job,id:919191,company:'Fixture',url:`http://127.0.0.1:${server.address().port}`},profilePath:join(dir,'profile.json'),resumePath:join(dir,'resume.pdf'),engine:'claude',maxSteps:3,parkQuestions:true,autoSubmit:false}));
 const execImpl=async(_c,_a,prompt)=>{
  reads++;const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls),field=controls.find(c=>c.name==='address');
  const done=field.value===expected,control=done?controls.find(c=>c.type==='submit'):field;
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:done?'review':'fill',control:control.id,fact:'addressZip',message:''},usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,'ready_to_submit',state.message);assert.equal(reads,2);
  assert.equal(state.review.answers.find(a=>a.label===label).value,expected);assert.equal(submits,0);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
