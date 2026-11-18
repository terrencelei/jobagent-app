import test from 'node:test';import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {runWorker} from '../src/dashboard-worker.mjs';

test('newer same-job visible approval prevents restoring obsolete internal-name answer',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'decision-bank-'));let posts=0,calls=0;
 const label='What is your earliest start date?',name='applicant[earliest_start_date]';
 const server=createServer((req,res)=>{if(req.method==='POST')posts++;res.setHeader('Content-Type','text/html');res.end(`<form><label for="date">${label}</label><input id="date" name="${name}" required><button type="submit">Submit application</button></form>`);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const run=join(dir,'run');await mkdir(run);await mkdir(join(dir,'companies'));const bank={company:'Fixture',answers:{[name]:{question:name,answer:'June 30, 2027',approvedFor:'42',approvedAt:'2026-01-01T00:00:00Z'},[label.toLowerCase()]:{question:label,answer:'2027-06-16',approvedFor:'42',approvedAt:'2026-02-01T00:00:00Z'}}};
  const bankPath=join(dir,'companies/fixture.json');await writeFile(bankPath,JSON.stringify(bank));await writeFile(join(dir,'profile.json'),JSON.stringify({answers:{earliestStartDate:'2027-06-16'}}));await writeFile(join(dir,'resume.pdf'),'fixture');
  await writeFile(join(run,'request.json'),JSON.stringify({job:{id:42,company:'Fixture',title:'Engineer',role_type:'FULL_TIME',url:`http://127.0.0.1:${server.address().port}`},profilePath:join(dir,'profile.json'),resumePath:join(dir,'resume.pdf'),engine:'claude',parkQuestions:true,maxSteps:6,approvedAnswers:[{question:label,answer:'2027-06-16'}]}));
  await runWorker(run,{allowLocalFixture:true,stateRoot:join(dir,'state'),execImpl:async(_c,_a,prompt)=>{
   calls++;const input=JSON.parse(prompt),controls=input.page.frames.flatMap(f=>f.controls),date=controls.find(c=>c.name===name),button=controls.find(c=>c.type==='submit');
   const stale=input.approvedQuestionAnswers[name];
   const action=stale?(calls>=4?{action:'human',control:date.id,fact:'',message:'Cannot restore old bank date'}:{action:'fill',control:date.id,fact:`bank:${name}`,message:''}):date.value==='2027-06-16'?{action:'review',control:button.id,fact:'',message:''}:{action:'fill',control:date.id,fact:'earliestStartDate',message:''};
   return{code:0,stderr:'',stdout:JSON.stringify({structured_output:action,usage:{}})};
  }});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));assert.equal(state.status,'ready_to_submit',state.message);assert.equal(calls,2);assert.equal(posts,0);const after=JSON.parse(await readFile(bankPath,'utf8'));assert.deepEqual(after.answers[name],bank.answers[name]);assert.equal(after.answers[label.toLowerCase()].answer,'2027-06-16');
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('alias suppression requires an exact DOM mapping and current job approval evidence',async()=>{
 const {decisionAnswerBank}=await import('../src/decision-answer-bank.mjs');
 const alias='applicant[start]',label='earliest start?',snap={frames:[{controls:[{name:alias,label}]}]};
 const bank={[alias]:{answer:'old',approvedFor:'42',approvedAt:'2026-01-01'},[label]:{answer:'new',approvedFor:'42',approvedAt:'2026-02-01'}};
 const result=decisionAnswerBank(bank,snap,{id:42});assert.equal(result.answers[alias],undefined);assert.deepEqual(result.supersededAnswerAliases,{[alias]:label});assert.ok(bank[alias]);
 for(const input of [
  {...bank,[alias]:{...bank[alias],approvedFor:'43'}},
  {...bank,[label]:{...bank[label],approvedFor:'43'}},
  {...bank,[alias]:{...bank[alias],shared:true}},
  {...bank,[label]:{...bank[label],shared:true}},
  {...bank,[label]:{...bank[label],approvedAt:bank[alias].approvedAt}},
  {...bank,[label]:{...bank[label],approvedAt:'invalid'}},
 ])assert.ok(decisionAnswerBank(input,snap,{id:42}).answers[alias]);
 assert.ok(decisionAnswerBank(bank,{frames:[{controls:[{name:alias,label:'unrelated'}]}]},{id:42}).answers[alias]);
 assert.ok(decisionAnswerBank(bank,{frames:[{controls:[{name:alias,label},{name:alias,label:'another question'}]}]},{id:42}).answers[alias]);
 assert.ok(decisionAnswerBank(bank,snap,{}).answers[alias]);
 const inMemory={...bank,[label]:{answer:'new'}};
 assert.ok(decisionAnswerBank(inMemory,snap,{id:42}).answers[alias]);
 assert.equal(decisionAnswerBank(inMemory,snap,{id:42},[{question:label,answer:'new'}]).answers[alias],undefined);
 assert.ok(decisionAnswerBank(inMemory,snap,{id:42},[{question:label,answer:'different'}]).answers[alias]);
});
