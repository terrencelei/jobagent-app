import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {approvedValue,choiceNeedsAction,runWorker,atomic} from '../src/dashboard-worker.mjs';
import {questionId} from '../src/companies.mjs';

// Employer preambles can mention employment while asking a separately approved question.
const label='If selected for employment, are there reasons you would not be able to support these missions?';
const control={label,type:'radio',optionLabel:'No',choiceLabels:['Yes','No','Other'],value:'false'};
const bank={[questionId(label)]:{answer:'No'}};
test('review-required native choices map the approved answer to the selected alternative',()=>{
 for(const type of ['radio','checkbox']){
  assert.equal(approvedValue({},{...control,type},{answers:{}},bank,new Map()),true);
  assert.equal(approvedValue({},{...control,type,optionLabel:'Yes'},{answers:{}},bank,new Map()),false);
  assert.equal(approvedValue({},{...control,type,optionLabel:'Other'},{answers:{}},bank,new Map()),false);
 }
 assert.equal(choiceNeedsAction({...control,value:'true'},{answers:{}},bank,new Map()),false);
 assert.equal(approvedValue({},{label,type:'text'},{answers:{}},bank,new Map()),'No');
 assert.equal(approvedValue({},control,{answers:{}},bank,new Map([[questionId(label),'Yes']])),false);
 assert.throws(()=>approvedValue({},control,{answers:{}},{},new Map()),/approved/);
 assert.throws(()=>approvedValue({},control,{answers:{}},{[questionId(label)]:{answer:'Unlisted'}},new Map()),/approved/);
});

test('approved No remains checked in required Lever radios and reaches review with zero POSTs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'reviewed-radio-')),run=join(dir,'run');await mkdir(run);
 let posts=0;
 const server=createServer((req,res)=>{if(req.method==='POST')posts++;res.setHeader('Content-Type','text/html');res.end(`<form method="post"><ul><li class="application-question"><div class="application-label">${label}<span class="required">*</span></div>${['Yes','No','Other'].map(v=>`<label><input type="radio" name="mission" value="${v}" required>${v}</label>`).join('')}</li></ul><button type="submit">Submit Application</button></form>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const profilePath=join(dir,'profile.json'),resumePath=join(dir,'resume.pdf');
  await writeFile(profilePath,JSON.stringify({answers:{}}));await writeFile(resumePath,'fixture');
  await mkdir(join(dir,'companies'));await writeFile(join(dir,'companies','fixture.json'),JSON.stringify({company:'Fixture',answers:bank}));
  await atomic(join(run,'request.json'),{job:{id:322,company:'Fixture',title:'Engineer',url:`http://127.0.0.1:${server.address().port}/apply`},profilePath,resumePath,engine:'claude',parkQuestions:true,maxSteps:3});
  await runWorker(run,{stateRoot:join(dir,'state'),allowLocalFixture:true,execImpl:async(_command,_args,prompt)=>{
   const fields=JSON.parse(prompt).page.frames.flatMap(f=>f.controls),choice=fields.find(c=>c.type==='radio'&&c.optionLabel==='No');
   const c=choice??fields.find(c=>c.type==='submit');
   return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:choice?'fill':'review',control:c.id,message:''},usage:{}})};
  }});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,'ready_to_submit',state.message);assert.equal(posts,0);
  assert.equal(state.review.answers.find(a=>a.label===label).value,'true');
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

const sourceLabel='How did you hear about us?';
const sourceOptions=['Campus visit','LinkedIn Post','LinkedIn Sponsored Job/Ad','Industry Conference','Twitter/X','Instagram','Referral','Handshake','Other'];
test('Lever mission and source groups reach review using approved No and authorized LinkedIn Post',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lever-two-groups-')),run=join(dir,'run');await mkdir(run);
 let posts=0;
 const group=(name,question,options)=>`<li class="application-question"><div class="application-label">${question}<span class="required">*</span></div>${options.map(v=>`<label><input type="radio" name="${name}" value="${v}" required>${v}</label>`).join('')}</li>`;
 const server=createServer((req,res)=>{if(req.method==='POST')posts++;res.setHeader('Content-Type','text/html');res.end(`<form method="post"><ul>${group('mission',label,['Yes','No','Other'])}${group('source',sourceLabel,sourceOptions)}</ul><button type="submit">Submit Application</button></form>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const profile={answers:{routineSourceChoiceAllowed:true}},profilePath=join(dir,'profile.json'),resumePath=join(dir,'resume.pdf');
  const source={label:sourceLabel,type:'radio',optionLabel:'LinkedIn Post',choiceLabels:sourceOptions};
  assert.equal(approvedValue({},source,profile,{},new Map(),'Fixture'),true);
  for(const optionLabel of sourceOptions.filter(x=>x!=='LinkedIn Post'))assert.equal(approvedValue({},{...source,optionLabel},profile,{},new Map(),'Fixture'),false);
  assert.throws(()=>approvedValue({},{...source,choiceLabels:['LinkedIn Employee Referral','Campus visit']},profile,{},new Map(),'Fixture'),/confirmed/);
  await writeFile(profilePath,JSON.stringify(profile));await writeFile(resumePath,'fixture');
  await mkdir(join(dir,'companies'));await writeFile(join(dir,'companies','fixture.json'),JSON.stringify({company:'Fixture',answers:bank}));
  await atomic(join(run,'request.json'),{job:{id:323,company:'Fixture',title:'Engineer',url:`http://127.0.0.1:${server.address().port}/apply`},profilePath,resumePath,engine:'claude',parkQuestions:true,maxSteps:4});
  await runWorker(run,{stateRoot:join(dir,'state'),allowLocalFixture:true,execImpl:async(_command,_args,prompt)=>{
   const fields=JSON.parse(prompt).page.frames.flatMap(f=>f.controls),choice=fields.find(c=>c.type==='radio'&&(c.label===label&&c.optionLabel==='No'||c.label===sourceLabel&&c.optionLabel==='LinkedIn Post'));
   const c=choice??fields.find(c=>c.type==='submit');
   return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:choice?'fill':'review',control:c.id,message:''},usage:{}})};
  }});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,'ready_to_submit',state.message);assert.equal(posts,0);
  for(const question of [label,sourceLabel])assert.equal(state.review.answers.find(a=>a.label===question).value,'true');
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
