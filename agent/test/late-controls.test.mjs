import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {runWorker,atomic} from '../src/dashboard-worker.mjs';
import {hasNewFormControls,hasVerificationControls} from '../src/control-identity.mjs';

for(const {late,verification=false,negativeGate=false,completedVerification=false,bridgeVerification=false,password=false} of [{late:true},{late:false},{late:true,verification:true},{late:true,negativeGate:true},{late:true,completedVerification:true},{late:true,bridgeVerification:true},{late:false,bridgeVerification:true},{late:true,bridgeVerification:true,verification:true},{late:true,bridgeVerification:true,password:true}])test(`human decision rechecks late authentication fields without reload or submission: late=${late}, verification=${verification}, negativeGate=${negativeGate}, completedVerification=${completedVerification}, bridgeVerification=${bridgeVerification}, password=${password}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'late-controls-')),run=join(dir,'run');await mkdir(run);
 let release,rendered,posts=0,loads=0,reads=0;
 const pending=new Promise(r=>release=r),ready=new Promise(r=>rendered=r);
 const server=createServer(async(req,res)=>{
  if(req.method==='POST')posts++;
  if(req.url==='/controls'){await pending;res.end((verification?'<label>Verification code<input name="otp"></label>':password?'<label>Password<input type="password"></label>':'')+'<form><label>Email Address<input type="email" required></label><label>I accept the Applicant Privacy Notice<input type="checkbox" required></label><button type="submit">Submit application</button></form>');return;}
  if(req.url==='/rendered'){rendered();res.end('ok');return;}
  if(req.url==='/favicon.ico'){res.end();return;}
  loads++;res.setHeader('Content-Type','text/html');res.end(`<a href="#content">Skip to content</a><main id="content"></main>${late?`<script>fetch('/controls').then(r=>r.text()).then(html=>{document.querySelector('main').innerHTML=html;fetch('/rendered')})</script>`:''}`);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await writeFile(profile,JSON.stringify({answers:{email:'applicant@example.test'}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:late?9911281:9911282,company:'Fixture',title:'Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,maxSteps:6});
 const execImpl=async(_cmd,_args,prompt)=>{
  reads++;const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);
  let action;
  if(reads===1){
   assert.equal(controls.some(c=>c.type==='email'),false);
   if(late){release();await ready;}
   action={action:'human',control:'',fact:'',message:bridgeVerification?'Stale control snapshot: the existing email bridge completed sign-in verification at 09:37:30 UTC. The saved screenshot shows this Amazon job’s application questions, but supplied controls contain only authentication footer buttons. Refresh the existing worker’s semantic control snapshot using its bounded late-control recovery; no further applicant verification or repeated sign-in is needed.':verification?'A verification code is required.':completedVerification?'Stale control snapshot: saved run confirms email verification completed through the existing bridge. The screenshot shows this job’s application questions, but supplied controls contain only the former authentication footer. Refresh the existing worker’s control snapshot and continue preparation; no applicant intervention is currently indicated.':negativeGate?'Stale snapshot after Next: supplied controls contain only Skip and Back, but the saved screenshot shows the application form with Last Name, First Name and resume upload. Refresh the existing worker control snapshot; no verification gate is visible.':'Authentication controls rendered after the supplied snapshot; refresh the snapshot.'};
  }else{
   assert.ok(controls.some(c=>c.type==='email'),'refreshed decision sees authentication');
   const email=controls.find(c=>c.type==='email'),terms=controls.find(c=>c.type==='checkbox');
   action=!email.value?{action:'fill',control:email.id,fact:'email'}:terms.value!=='true'?{action:'fill',control:terms.id,fact:'acceptTerms'}:{action:'review',control:controls.find(c=>c.type==='submit').id};
  }
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{fact:'',message:'',...action},usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,late&&!verification&&!password?'ready_to_submit':'needs_human',state.message);
  assert.equal(reads,late&&!verification&&!password?3:1);  // the required checkbox is ticked without a model step (lesson 431)assert.equal(posts,0);assert.equal(loads,1,'do not reload the employer page');
  assert.equal(Boolean(state.submission_attempted),false);
  assert.equal(state.events.some(e=>/New form controls appeared/.test(e.message)),late&&!verification&&!password);
 }finally{release();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('late field detection ignores DOM replacement, ordinal IDs, values and new navigation links',()=>{
 const field={type:'email',label:'Email Address',name:'email',domId:'email',id:'f0c1',nodeKey:'old',value:''};
 const snap=controls=>({frames:[{frameIndex:0,url:'https://fixture.example.test/apply',controls}]});
 assert.equal(hasNewFormControls(snap([field]),snap([{...field,id:'f0c8',nodeKey:'new',value:'applicant@example.test'},{type:'a',label:'Privacy'}])),false);
 assert.equal(hasNewFormControls(snap([{type:'a',label:'Back'}]),snap([field])),true);
 assert.equal(hasNewFormControls(snap([field]),snap([field,{type:'checkbox',label:'Applicant Privacy Notice'}])),true);
});

test('snapshot boundaries preserve code, password and CAPTCHA stops without classifying prose',()=>{
 const snap=(controls=[],text='')=>({frames:[{controls,text}]});
 for(const control of [{type:'password',label:'Password'},{type:'text',label:'Verification code'},{type:'text',name:'otp'},{type:'tel',domId:'security code'},{type:'checkbox',label:"I am not a robot"}])assert.equal(hasVerificationControls(snap([control])),true);
 for(const text of ['Verify your email','Enter your six-digit code'])assert.equal(hasVerificationControls(snap([],text)),true);
 assert.equal(hasVerificationControls(snap([{type:'email',label:'Email'},{type:'text',label:'Full legal name'}],'Experience developing design verification plans?')),false);
});

test('complete sign-in forms may refresh while real verification and ambiguous credentials stay gated',()=>{
 const signin=[{type:'email',label:'Email Address'},{type:'password',label:'Password'},{type:'submit',label:'Sign In'}];
 const snap=(controls,text='')=>({frames:[{controls,text}]});
 assert.equal(hasVerificationControls(snap(signin)),false);
 assert.equal(hasVerificationControls(snap(signin.map(c=>c.type==='email'?{type:'text',label:'Email Address:*'}:c))),false);
 for(const extra of [{type:'text',name:'otp'},{type:'text',label:'Verification code'},{type:'checkbox',label:'I am not a robot'},{type:'password',label:'Confirm password'}])assert.equal(hasVerificationControls(snap([...signin,extra])),true);
 assert.equal(hasVerificationControls(snap(signin,'Enter your security code')),true);
 assert.equal(hasVerificationControls(snap(signin.filter(c=>c.type!=='email'))),true);
 assert.equal(hasVerificationControls(snap(signin.map(c=>c.label==='Sign In'?{...c,label:'Submit application'}:c))),true);
 assert.equal(hasVerificationControls({frames:[{controls:signin},{controls:[{type:'text',name:'otp'}]}]}),true);
});

for(const gate of ['signin','code'])test(`late Loading snapshot to ${gate} respects authentication boundaries without reload or submission`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'late-signin-')),run=join(dir,'run'),root=join(dir,'account');await mkdir(run);await mkdir(join(root,'private'),{recursive:true});
 let release,rendered,posts=0,loads=0,reads=0;
 const pending=new Promise(r=>release=r),ready=new Promise(r=>rendered=r);
 const server=createServer(async(req,res)=>{
  if(req.method==='POST')posts++;
  res.setHeader('Content-Type','text/html');
  if(req.url==='/controls'){await pending;res.end(`<h2>Career Opportunities: Sign In</h2><form onsubmit="event.preventDefault();document.querySelector('main').innerHTML='<form><label>First name<input required></label><button type=submit>Submit application</button></form>'"><label>Email Address:*<input type="text" required></label><label>Password:*<input type="password" required></label>${gate==='code'?'<label>Verification code<input name="otp"></label>':''}<button type="submit">Sign In</button></form>`);return;}
  if(req.url==='/rendered'){rendered();res.end('ok');return;}
  if(req.url==='/favicon.ico'){res.end();return;}
  loads++;res.end('<main>Loading</main><script>fetch("/controls").then(r=>r.text()).then(html=>{document.querySelector("main").innerHTML=html;fetch("/rendered")})</script>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await writeFile(profile,JSON.stringify({answers:{email:'applicant@example.test',firstName:'Fixture'}}));await writeFile(resume,'fixture');
 // Only the runner reads this synthetic fixture credential.
 await writeFile(join(root,'private','credentials.json'),JSON.stringify({fixture:{host:'127.0.0.1',email:'applicant@example.test',password:'fixture-only-password'}}));
 await atomic(join(run,'request.json'),{job:{id:9911283,company:'Fixture Signin',title:'Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,autoSubmit:false,maxSteps:8});
 const execImpl=async(_cmd,_args,prompt)=>{
  reads++;const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);let action;
  if(reads===1){assert.equal(controls.length,0);release();await ready;action={action:'human',message:'Stale control snapshot: screenshot shows Career Opportunities: Sign In but supplied controls show only Loading. Refresh controls through the existing worker.'};}
  else if(controls.some(c=>c.type==='password')){
   const email=controls.find(c=>c.label.startsWith('Email')),password=controls.find(c=>c.type==='password');
   action=!email.value?{action:'fill',control:email.id,fact:'email'}:!password.value&&reads===3?{action:'fill',control:password.id,fact:'accountPassword'}:{action:'click',control:controls.find(c=>c.label==='Sign In').id};
  }else{
   const first=controls.find(c=>c.label==='First name');
   action=!first.value?{action:'fill',control:first.id,fact:'firstName'}:{action:'review',control:controls.find(c=>c.type==='submit').id};
  }
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{fact:'',message:'',...action},usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,accountRoot:root,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,gate==='signin'?'ready_to_submit':'needs_human',state.message);
  assert.equal(reads,gate==='signin'?6:1);assert.equal(posts,0);assert.equal(loads,1);
  assert.equal(Boolean(state.submission_attempted),false);
  assert.equal(state.events.some(e=>/New form controls appeared/.test(e.message)),gate!=='code');
 }finally{release();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
