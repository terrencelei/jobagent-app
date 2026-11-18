import test from 'node:test';
import assert from 'node:assert/strict';
import {scriptedFormAction} from '../src/form-automation.mjs';
import * as worker from '../src/dashboard-worker.mjs';

const job={id:42,company:'Fixture',title:'Mechanical Engineer',location:'United States',role_type:'FULL_TIME'};
const profile={answers:{firstName:'Fixture',email:'fixture@example.test',workAuthorized:'Yes',requiresSponsorship:'No'}};
const c=(id,label,type='text',extra={})=>({id,nodeKey:id,label,type,value:'',...extra});
const snap=controls=>({url:'https://example.test/apply',frames:[{frameIndex:0,controls,text:''}]});
const plan=(controls,extra={})=>scriptedFormAction({snap:snap(controls),profile,job,...extra},worker);

test('a confirmed contact fact is filled without a model step, once per control state',()=>{
 const attempts=new Set(),name=c('name','First Name*');
 assert.deepEqual(plan([name],{attempts}),{action:'fill',control:'name',fact:'firstName',message:''});
 assert.equal(plan([name],{attempts}),null,'a fill that did not stick goes back to the agent');
 assert.equal(plan([c('name','First Name*','text',{value:'Fixture'})]),null,'already correct');
});

test('only fills are scripted: sign-in, navigation and final review stay with the agent',()=>{
 const filled=c('email','Email','email',{value:'fixture@example.test'});
 assert.equal(plan([filled,c('s','Submit application','submit')]),null);
 assert.equal(plan([filled,c('n','Continue','button')]),null);
 assert.equal(plan([c('e','Email','email'),c('p','Password','password')]),null,'sign-in page');
});

test('prose, history rows, uploads, pickers, rejections and inexact options fall back',()=>{
 const bank={'why this company?':{question:'Why this company?',answer:'Wording he approved for another employer.'}};
 for(const control of [
  c('why','Why this company?','textarea'),
  c('secret','What is your secret ambition?','text',{required:true}),
  c('history','Email','text',{historySection:'workHistory'}),
  c('cv','Resume','file',{required:true}),
  c('combo','First Name','text',{combobox:true}),
  c('auth','Are you legally authorized to work in the United States?','select-one',{options:[{label:'No',value:'no'}]}),
 ])assert.equal(plan([control],{bank}),null,control.label);
 assert.equal(plan([c('name','First Name')],{history:[{action:'rejected'}]}),null);
});

import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createServer} from 'node:http';
// The same form reaches the same review with fewer model steps, and nothing is submitted.
async function runFixture(scriptedActions){
 const dir=await mkdtemp(join(tmpdir(),'scripted-fill-')),run=join(dir,'run'),stateRoot=join(dir,'state');
 await mkdir(run);await mkdir(stateRoot);let posts=0,decisions=0;
 const server=createServer((req,res)=>{if(req.method==='POST')posts++;res.setHeader('Content-Type','text/html');
  res.end('<form method="post"><label>First Name<input name="f" required></label><label>Email<input type="email" name="e" required></label><label>Phone<input type="tel" name="p" required></label><button type="submit">Submit application</button></form>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 const profilePath=join(dir,'profile.json'),resumePath=join(dir,'resume.pdf');
 await writeFile(profilePath,JSON.stringify({answers:{firstName:'Fixture',email:'fixture@example.test',phone:'555-0100'}}));await writeFile(resumePath,'fixture');
 await writeFile(join(run,'request.json'),JSON.stringify({job:{id:999998,company:'Fixture',title:'Engineer',url},profilePath,resumePath,engine:'claude',parkQuestions:true,autoSubmit:false,scriptedActions}));
 const facts={'First Name':'firstName','Email':'email','Phone':'phone'};
 const execImpl=async(_c,_a,prompt)=>{decisions++;const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);
  const empty=controls.find(c=>facts[c.label]&&!c.value);const submit=controls.find(c=>c.type==='submit');
  const action=empty?{action:'fill',control:empty.id,fact:facts[empty.label],message:''}:{action:'review',control:submit.id,fact:'',message:''};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:action,usage:{}})};};
 try{await worker.runWorker(run,{execImpl,stateRoot,allowLocalFixture:true});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));return {state,decisions,posts};}
 finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
}
test('a local form reaches the same review with fewer model steps when confirmed fields are scripted',async()=>{
 const agent=await runFixture(false),scripted=await runFixture(true);
 for(const r of [agent,scripted]){assert.equal(r.state.status,'ready_to_submit',r.state.message);assert.equal(r.posts,0);}
 assert.deepEqual(scripted.state.review.answers.map(a=>a.value).sort(),agent.state.review.answers.map(a=>a.value).sort());
 assert.equal(agent.decisions,4);assert.equal(scripted.decisions,1);
});
