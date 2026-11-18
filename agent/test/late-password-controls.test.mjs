import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {runWorker,atomic} from '../src/dashboard-worker.mjs';
import {hasVerificationControls} from '../src/control-identity.mjs';

for(const code of [false,true])test(`late password-only step refreshes without reload while verification stays gated: code=${code}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'late-password-')),run=join(dir,'run'),root=join(dir,'account');
 await mkdir(run);await mkdir(join(root,'private'),{recursive:true});
 let release,rendered,reads=0,posts=0,loads=0;
 const pending=new Promise(r=>release=r),ready=new Promise(r=>rendered=r);
 const server=createServer(async(req,res)=>{
  if(req.method==='POST')posts++;
  res.setHeader('Content-Type','text/html');
  if(req.url==='/controls'){await pending;res.end(`<style>label,button{display:block}</style><h1>Enter your password</h1><form onsubmit="event.preventDefault();document.querySelector('main').innerHTML='<form><label>First name<input required></label><button type=submit>Submit application</button></form>'"><label>Password<input type="password" required oninput="this.form.querySelector('button').disabled=!this.value"></label>${code?'<label>Security code<input name="otp"></label>':''}<button type="submit" disabled>Continue</button></form>`);return;}
  if(req.url==='/rendered'){rendered();res.end('ok');return;}
  if(req.url==='/favicon.ico'){res.end();return;}
  loads++;res.end('<footer><button>Settings</button><button>Get Help</button></footer><main></main><script>fetch("/controls").then(r=>r.text()).then(html=>{document.querySelector("main").innerHTML=html;fetch("/rendered")})</script>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');
 await writeFile(profile,JSON.stringify({answers:{email:'fixture@example.test',firstName:'Fixture'}}));await writeFile(resume,'fixture');
 await writeFile(join(root,'private','credentials.json'),JSON.stringify({fixture:{host:'127.0.0.1',email:'fixture@example.test',password:'synthetic-local-only'}}));
 await atomic(join(run,'request.json'),{job:{id:9911285,company:'Fixture Password',title:'Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,autoSubmit:false,maxSteps:8});
 const execImpl=async(_cmd,_args,prompt)=>{
  reads++;const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);let action;
  if(reads===1){assert.equal(controls.some(c=>c.type==='password'),false);release();await ready;action={action:'human',message:'Saved screenshot shows Enter your password, Password and Continue, but supplied controls contain footer only. Refresh the existing controls; no verification-code gate shown.'};}
  else if(controls.some(c=>c.type==='password')){
   const password=controls.find(c=>c.type==='password');assert.equal(password.value,'','password never appears in model snapshot');
   action=reads===2?{action:'fill',control:password.id,fact:'accountPassword'}:{action:'click',control:controls.find(c=>c.label==='Continue').id};
  }else{
   const first=controls.find(c=>c.label==='First name');action=!first.value?{action:'fill',control:first.id,fact:'firstName'}:{action:'review',control:controls.find(c=>c.type==='submit').id};
  }
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{fact:'',message:'',...action},usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,accountRoot:root,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,code?'needs_human':'ready_to_submit',state.message);
  assert.equal(reads,code?1:5);assert.equal(posts,0);assert.equal(loads,1);
  assert.equal(Boolean(state.submission_attempted),false);
  assert.equal(state.events.some(e=>/New form controls appeared/.test(e.message)),!code);
 }finally{release();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('password-only refresh requires caller host validation and exact ordinary sign-in semantics',()=>{
 const controls=[{type:'password',label:'Password'},{type:'submit',label:'Continue'}];
 const snap=(cs=controls,text='Enter your password')=>({frames:[{url:'https://fixture.example/signin',controls:cs,text}]});
 const allowed={passwordSigninAllowed:()=>true};
 assert.equal(hasVerificationControls(snap()),true,'host permission must be explicit');
 assert.equal(hasVerificationControls(snap(),{passwordSigninAllowed:()=>false}),true);
 assert.equal(hasVerificationControls(snap(),allowed),false);
 assert.equal(hasVerificationControls(snap([controls[0]],'Enter your password\nPassword\nContinue'),allowed),false,'disabled Continue is visible text but absent from actionable controls');
 assert.equal(hasVerificationControls(snap([controls[0]],'Enter your password\nContinue\nSubmit application'),allowed),true);
 for(const text of ['Create your password','Reset your password','Enter your password\nEnter your security code'])assert.equal(hasVerificationControls(snap(controls,text),allowed),true);
 for(const extra of [{type:'password',label:'Confirm password'},{type:'text',name:'otp'},{type:'checkbox',label:'I am not a robot'}])assert.equal(hasVerificationControls(snap([...controls,extra]),allowed),true);
 assert.equal(hasVerificationControls(snap([controls[0],{type:'submit',label:'Submit application'}]),allowed),true);
 assert.equal(hasVerificationControls({frames:[...snap().frames,{controls:[{type:'text',label:'Security code'}]}]},allowed),true);
});
