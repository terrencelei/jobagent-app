import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {shouldApproveOptionalWriting} from '../src/application-writing-policy.mjs';
import {runWorker} from '../src/dashboard-worker.mjs';
import {isShortAnswer} from '../src/answer-learning.mjs';

test('optional substantive writing gets review while facts, choices and opt-ins keep their rules',()=>{
 for(const label of ['What else should we know about you that is not reflected on your LinkedIn or resume?','Why Apex?','Why us?','Why are you a good fit for this role?','What achievements are you most proud of?','Describe a challenge you faced','Tell us about a project you built'])
  for(const type of ['text','textarea'])assert.equal(shouldApproveOptionalWriting({label,type}),true,label);
 for(const label of ['Optional notes','What is your citizenship?','Why do you require visa sponsorship?','Your LinkedIn URL','Subscribe to company updates'])
  assert.equal(shouldApproveOptionalWriting({label,type:'textarea'}),false,label);
 assert.equal(shouldApproveOptionalWriting({label:'Why us?',type:'select',options:['A','B']}),false);
 assert.equal(isShortAnswer({label:'Explain a project',type:'text',required:true,employerRequired:false}),true);
});

for(const approved of [false,true])test(`optional Why Apex is gated before model Review; approved=${approved}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'optional-writing-')),run=join(dir,'run');await mkdir(run);
 const wording='I want to apply my confirmed mechanical design experience to this role.';
 const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<form><label>Why Apex?<textarea name="why"></textarea></label><button type="submit">Submit application</button></form>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profilePath=join(dir,'profile.json'),resumePath=join(dir,'resume.pdf');
 await writeFile(profilePath,JSON.stringify({answers:{}}));await writeFile(resumePath,'fixture');
 await writeFile(join(run,'request.json'),JSON.stringify({job:{id:42,company:'Fixture Employer',title:'Mechanical Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath,resumePath,engine:'claude',command:'fixture',parkQuestions:true,autoSubmit:!approved,maxSteps:3,approvedAnswers:approved?[{question:'Why Apex?',answer:wording,type:'textarea'}]:[]}));
 const execImpl=async(_command,_args,input)=>{const controls=JSON.parse(input).page.frames.flatMap(f=>f.controls);return{code:0,stdout:JSON.stringify({structured_output:{action:'review',control:controls.find(c=>c.type==='submit').id,fact:'',message:''}})};};
 try{
  await runWorker(run,{execImpl,stateRoot:join(dir,'state'),allowLocalFixture:true});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,approved?'ready_to_submit':'needs_approval',state.message);
  if(approved)assert.equal(state.review.answers.find(a=>a.label==='Why Apex?').value,wording);
  else{assert.equal(state.questions[0].label,'Why Apex?');assert.equal(state.questions[0].required,true);assert.equal(state.questions[0].employerRequired,false);assert.notEqual(state.submitted,true);}
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
