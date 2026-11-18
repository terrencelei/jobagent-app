import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveUnknownQuestion} from '../src/dashboard-worker.mjs';
const base={question:{label:'Which CAD experience do you have?',type:'text',required:true},profile:{answers:{solidworksExperience:'Some experience'}},bank:{},job:{company:'Fixture',title:'Mechanical Engineer',url:'https://example.com'}};
test('known profile facts resolve with equivalent options before consulting the model',async()=>{
 const input={...base,question:{label:'Do you hold an active security clearance?',options:['None','Secret']},profile:{answers:{currentSecurityClearance:'No'}},execImpl:async()=>{throw new Error('Known facts should not require a model call');}};
 const result=await resolveUnknownQuestion(input);
 assert.equal(result.resolved,true);assert.equal(result.value,'None');
 assert.equal((await resolveUnknownQuestion({...input,question:{...input.question,options:['Secret','Top Secret']}})).resolved,false);
 const work=await resolveUnknownQuestion({...input,question:{label:'Are you authorized to work in this country?',options:['Yes','No']},job:{...base.job,location:'United States'},profile:{answers:{workAuthorizationCountries:['United States']}}});
 assert.equal(work.value,'Yes');
});
function cli(action,engine='claude'){
 return async(command,args,prompt)=>{
  assert.equal(command,`/fixture/${engine}`);
  assert.ok(JSON.parse(engine==='codex'?prompt.slice(prompt.indexOf('{"job"')):prompt).confirmedAnswers.solidworksExperience);
  return {code:0,stderr:'',stdout:engine==='claude'?JSON.stringify({structured_output:action,usage:{input_tokens:1}}):JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(action)}})};
 };
}
for(const engine of ['claude','codex'])test(`${engine} resolves unknown question from verified facts`,async()=>{
 const r=await resolveUnknownQuestion({...base,engine,command:`/fixture/${engine}`,execImpl:cli({action:'fill',control:'question',fact:'solidworksExperience',message:'invented wording'},engine)});
 assert.equal(r.value,'Some experience');assert.equal(r.resolved,true);
});
test('unavailable fact, invented answer and mismatched option require user information',async()=>{
 for(const action of [{action:'ask',control:'question',fact:'',message:'No'}, {action:'fill',control:'question',fact:'madeUp',message:'Yes'}]){
  assert.equal((await resolveUnknownQuestion({...base,engine:'claude',command:'/fixture/claude',execImpl:cli(action)})).resolved,false);
 }
 const r=await resolveUnknownQuestion({...base,question:{...base.question,options:['Expert','None']},engine:'claude',command:'/fixture/claude',execImpl:cli({action:'fill',control:'question',fact:'solidworksExperience',message:''})});
 assert.equal(r.resolved,false);
});
test('approved wording can be reused but novel prose cannot be invented',async()=>{
 const input={...base,question:{label:'Describe CAD experience',type:'textarea'},bank:{cad:{answer:'I have some SolidWorks experience.'}},engine:'claude',command:'/fixture/claude'};
 const r=await resolveUnknownQuestion({...input,execImpl:cli({action:'fill',control:'question',fact:'bank:cad',message:''})});
 assert.equal(r.value,'I have some SolidWorks experience.');
 assert.equal((await resolveUnknownQuestion({...input,execImpl:cli({action:'fill',control:'question',fact:'solidworksExperience',message:'I am an expert'})})).resolved,false);
});
test('CLI session limits propagate instead of becoming a missing-answer question',async()=>{
 await assert.rejects(resolveUnknownQuestion({...base,engine:'claude',execImpl:async()=>({code:1,stderr:'',stdout:JSON.stringify({is_error:true,result:"You've hit your session limit"})})}),/usage limit reached/);
});

test('Workday adapter hands its question resolver the run request with the selected CLI configuration',async()=>{
 const {mkdtemp,mkdir,writeFile,readFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {EventEmitter}=await import('node:events');
 const {runWorkday}=await import('../src/dashboard-workday.mjs');
 const root=await mkdtemp(join(tmpdir(),'workday-agent-test-'));const run=join(root,'run');
 try{
  await mkdir(run);await mkdir(join(root,'state'));
  const request={job:{id:1,company:'Fixture',title:'Mechanical Engineer',url:'https://fixture.myworkdayjobs.com/jobs'},profilePath:join(root,'profile.json'),engine:'codex',command:'/fixture/codex',model:'fixture-model'};
  await writeFile(join(root,'profile.json'),JSON.stringify({resumePath:'resume.pdf',answers:{}}));await writeFile(join(root,'resume.pdf'),'fixture resume');
  await writeFile(join(run,'request.json'),JSON.stringify(request));
  let resolverRequest=null;
  await runWorkday(run,{root,spawnImpl:(_command,_args,options)=>{
   // What the resolver (tools/workday-run.mjs) would read: the file JOBAGENT_QUESTION_AGENT names.
   resolverRequest=options.env.JOBAGENT_QUESTION_AGENT;
   const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
   setTimeout(async()=>{await writeFile(join(root,'state','jobagent-1.json'),JSON.stringify({status:'at_review',updatedAt:new Date().toISOString()}));child.emit('close',0);},20);
   return child;
  }});
  assert.equal(JSON.parse(await readFile(join(run,'state.json'))).status,'ready_to_submit');
  assert.equal(resolverRequest,join(run,'request.json'));
  const seen=JSON.parse(await readFile(resolverRequest));
  assert.deepEqual([seen.engine,seen.command,seen.model],['codex','/fixture/codex','fixture-model']);
 }finally{await rm(root,{recursive:true,force:true});}
});
