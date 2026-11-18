import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {runWorker,atomic} from '../src/dashboard-worker.mjs';

// ArcBest 12717 (Avature): the application-methods page offers a Log in form and an "Upload Resume, Continue" path
// that registers a new profile behind a reCAPTCHA. The account already exists, so Continue led to a CAPTCHA dead end.
test('with a login form on the page the worker signs in before following the create-profile path',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'avature-signin-first-')),run=join(dir,'run'),root=join(dir,'account');
 await mkdir(run);await mkdir(join(root,'private'),{recursive:true});
 let registerLoads=0,formLoads=0,logins=0;
 const server=createServer((req,res)=>{
  const signedIn=/session=1/.test(req.headers.cookie??'');
  if(req.method==='POST'&&req.url.startsWith('/careersmarketplace/Login')){logins++;res.writeHead(302,{'Set-Cookie':'session=1; Path=/',Location:'/careersmarketplace/ApplicationGeneral?jobId=29813'});return res.end();}
  res.setHeader('Content-Type','text/html');
  if(req.url==='/favicon.ico')return res.end();
  if(req.url.startsWith('/careersmarketplace/ApplicationMethods'))return res.end('<h1>Apply</h1><form method="post" action="/careersmarketplace/Login"><label>Email<input type="email" name="email" required></label><label>Password<input type="password" name="password" required></label><button type="submit">Log in</button></form><h2>New here?</h2><form action="/careersmarketplace/Register"><label>Upload Resume<input type="file" name="resume"></label><button type="submit">Continue</button></form>');
  if(req.url.startsWith('/careersmarketplace/Register')){registerLoads++;return res.end('<h1>Create your profile</h1><label>Password *<input type="password"></label><label>Confirm your password: *<input type="password"></label>');}
  if(req.url.startsWith('/careersmarketplace/ApplicationGeneral')){if(!signedIn){res.writeHead(302,{Location:'/careersmarketplace/ApplicationMethods?jobId=29813'});return res.end();}formLoads++;return res.end('<h1>Application</h1><form method="post"><label>Phone *<input required></label><button type="submit">Submit</button></form>');}
  res.statusCode=404;res.end('missing');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');
 await writeFile(profile,JSON.stringify({answers:{email:'fixture@example.test',firstName:'Fixture'}}));await writeFile(resume,'fixture');
 await writeFile(join(root,'private','credentials.json'),JSON.stringify({fixture:{host:'127.0.0.1',email:'fixture@example.test',password:'synthetic-local-only'}}));
 await atomic(join(run,'request.json'),{job:{id:9912717,company:'Fixture ArcBest',title:'Test and Reliability Engineer I',url:`${base}/careersmarketplace/ApplicationMethods?jobId=29813`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,autoSubmit:false,maxSteps:10});
 let passwordFilled=false,continueTried=false;
 const execImpl=async(_c,_a,prompt)=>{
  const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);const by=l=>controls.find(c=>c.label===l);
  let action;
  // The step model's first instinct is the new-profile path, as in run dd01dd5f.
  if(by('Continue')&&!continueTried){continueTried=true;action={action:'click',control:by('Continue').id};}
  else if(by('Password')){const email=by('Email');if(email&&!email.value)action={action:'fill',control:email.id,fact:'email'};else if(!passwordFilled){passwordFilled=true;action={action:'fill',control:by('Password').id,fact:'accountPassword'};}else action={action:'click',control:by('Log in').id};}
  else if(by('Phone *'))action={action:'human',message:'fixture stop on the application form'};
  else action={action:'human',message:'fixture: unexpected page'};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{fact:'',message:'',...action},usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,accountRoot:root,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));const messages=state.events.map(e=>e.message);
  assert.ok(messages.some(m=>/Continue would create a profile; sign in first/.test(m)),JSON.stringify(messages));
  assert.ok(messages.includes('Signing in: Log in'),JSON.stringify(messages));
  assert.ok(messages.some(m=>/fixture stop on the application form/.test(m)),JSON.stringify(messages));
  assert.equal(registerLoads,0);assert.equal(logins,1);assert.equal(formLoads,1);
  assert.equal(Boolean(state.submission_attempted),false);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
