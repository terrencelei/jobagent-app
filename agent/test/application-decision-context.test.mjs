import test from 'node:test';
import assert from 'node:assert/strict';
import {applicationDecisionContext,FORM_AGENT_INSTRUCTIONS} from '../src/application-decision-context.mjs';

test('form agent receives existing run evidence and failures older than eight steps without answer secrets',()=>{
 const history=[{action:'rejected',control:'The owned dropdown did not retain the selected option',value:'do-not-copy-password'}];
 for(let i=0;i<18;i++)history.push({action:'fill',control:'Current location',value:'private-answer'});
 const context=applicationDecisionContext({job:{id:42},runDir:'/tmp/application-fixture/run-7',jobStatePath:'/tmp/application-fixture/state/jobagent-42.json',artifactRoot:'/tmp/application-fixture/artifacts',history,
  pendingQuestions:[{label:'Why this role?',type:'textarea',required:true,draft:'private unapproved draft',answer:'private-answer'}]});
 assert.deepEqual(context.run,{jobId:42,runId:'run-7',directory:'/tmp/application-fixture/run-7',requestPath:'/tmp/application-fixture/run-7/request.json',statePath:'/tmp/application-fixture/run-7/state.json',workerLogPath:'/tmp/application-fixture/run-7/worker.log',screenshotPath:'/tmp/application-fixture/run-7/screenshot.jpg',durableStatePath:'/tmp/application-fixture/state/jobagent-42.json',artifactsDirectory:'/tmp/application-fixture/artifacts/jobagent-42'});
 assert.deepEqual(context.progress.rejectedActions,[{reason:'The owned dropdown did not retain the selected option',count:1}]);
 assert.deepEqual(context.progress.repeatedControls,[{action:'fill',control:'Current location',count:18}]);
 assert.deepEqual(context.progress.pendingQuestions,[{label:'Why this role?',type:'textarea',required:true}]);
 assert.doesNotMatch(JSON.stringify(context),/do-not-copy-password|private-answer|private unapproved draft/);
});

test('question-only resolver does not invent a live run and bounded summaries cannot flood prompt',()=>{
 assert.deepEqual(applicationDecisionContext().run,{});
 const context=applicationDecisionContext({job:{id:'jobagent-8'},artifactRoot:'/tmp/fixture',history:Array.from({length:50},(_,i)=>({action:'rejected',control:`failure ${i}`})),pendingQuestions:Array.from({length:50},(_,i)=>({label:`Question ${i}`}))});
 assert.equal(context.run.artifactsDirectory,'/tmp/fixture/jobagent-8');
 assert.equal(context.run.directory,undefined);
 assert.equal(context.progress.rejectedActions.length,12);
 assert.equal(context.progress.pendingQuestions.length,30);
 assert.equal(context.progress.rejectedActions.at(-1).reason,'failure 49');
});

test('form-step contract preserves approvals and routes email verification through authorized bridge',()=>{
 assert.match(FORM_AGENT_INSTRUCTIONS,/Optional motivation, fit, achievements, project and challenge writing must also be sent for applicant review/);
 assert.match(FORM_AGENT_INSTRUCTIONS,/Other optional unknown fields may remain blank; never guess/);
 assert.match(FORM_AGENT_INSTRUCTIONS,/do not claim the applicant must retrieve a code before that bridge has been checked/);
 assert.match(FORM_AGENT_INSTRUCTIONS,/never create a competing browser or submit from a tool/);
 assert.match(FORM_AGENT_INSTRUCTIONS,/Do not click submit: choose review/);
 assert.match(FORM_AGENT_INSTRUCTIONS,/Match exact meaning and employer scope/);
 assert.doesNotMatch(FORM_AGENT_INSTRUCTIONS,/Leave optional unanswered questions blank|CAPTCHA, a verification code or email link, or a sign-in that already failed: human/);
});

test('CLI decision receives run context and aligned system contract without spawning another application',async()=>{
 const {decide}=await import('../src/dashboard-worker.mjs');
 let captured;
 const result=await decide({engine:'claude',job:{id:42,company:'Fixture Company',title:'Mechanical Engineer',url:'https://example.test/role',location:'United States'},profile:{answers:{}},bank:{},snap:{url:'https://example.test/role',frames:[]},history:[{action:'rejected',control:'Owned dropdown did not advance'}],context:{runDir:'/tmp/decision-fixture/run-42',jobStatePath:'/tmp/decision-fixture/state/jobagent-42.json'},execImpl:async(_command,args,prompt)=>{
  captured={args,input:JSON.parse(prompt)};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:'human',control:'',fact:'',message:'Local fixture inspection complete'},usage:{}})};
 }});
 assert.equal(result.action.action,'human');
 assert.equal(captured.input.job.id,42);
 assert.equal(captured.input.job.url,'https://example.test/role');
 assert.equal(captured.input.run.statePath,'/tmp/decision-fixture/run-42/state.json');
 assert.equal(captured.input.run.durableStatePath,'/tmp/decision-fixture/state/jobagent-42.json');
 assert.equal(captured.input.progress.rejectedActions[0].reason,'Owned dropdown did not advance');
 const flag=captured.args.includes('--append-system-prompt')?'--append-system-prompt':'--system-prompt';
 const instructions=captured.args[captured.args.indexOf(flag)+1];
 assert.match(instructions,/before that bridge has been checked/);
 assert.match(instructions,/Optional motivation, fit, achievements, project and challenge writing must also be sent for applicant review/);
});

test('a saved sign-in password is announced to the step model without the secret (Firefly 13401, lesson 486)',()=>{
 const withAccount=applicationDecisionContext({job:{id:13401},savedSignIn:true});
 assert.match(withAccount.signIn.accountPassword,/^available/);
 assert.match(withAccount.signIn.accountPassword,/prefer a password sign-in link over an emailed sign-in link/);
 assert.equal(applicationDecisionContext({job:{id:13401}}).signIn,undefined);
 assert.match(FORM_AGENT_INSTRUCTIONS,/every password field \(including confirm password\) with fact accountPassword/);
});
