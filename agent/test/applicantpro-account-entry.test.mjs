import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {authEntry} from '../src/accounts.mjs';
import {runWorker,atomic} from '../src/dashboard-worker.mjs';

test('ApplicantPro "Need an account? Click here!" opens registration', () => {
  assert.ok(authEntry('Need an account? Click here!'));
  assert.ok(authEntry("Don't have an account? Sign up"));
  assert.ok(!authEntry('Forgot Your Password?'));
  assert.ok(!authEntry('Click here!'));
});

// X-Bow 12727: the login page has a password field, so only sign-in buttons were accepted and
// the registration link was rejected as "not a Next, Continue, Apply ..." button.
test('registration link on a login page with a password field is followed', async () => {
  const dir=await mkdtemp(join(tmpdir(),'applicantpro-entry-')),run=join(dir,'run'),root=join(dir,'account');
  await mkdir(run);await mkdir(join(root,'private'),{recursive:true});
  let registerLoads=0,posts=0;
  const server=createServer((req,res)=>{
    res.setHeader('Content-Type','text/html');
    if(req.method==='POST'){posts++;return res.end('posted');}
    if(req.url.startsWith('/register')){registerLoads++;return res.end('<h1>Create Account</h1><label>First name<input required></label>');}
    if(req.url==='/favicon.ico')return res.end();
    res.end('<h1>Login</h1><form method="post"><label>Email<input type="email" required></label><label>Password<input type="password" required></label><button type="submit">Log In</button></form><a href="/register">Need an account? Click here!</a><a href="/forgot">Forgot Your Password?</a>');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');
  await writeFile(profile,JSON.stringify({answers:{email:'fixture@example.test',firstName:'Fixture'}}));await writeFile(resume,'fixture');
  await writeFile(join(root,'private','credentials.json'),JSON.stringify({fixture:{host:'127.0.0.1',email:'fixture@example.test',password:'synthetic-local-only'}}));
  await atomic(join(run,'request.json'),{job:{id:9912727,company:'Fixture ApplicantPro',title:'Engineer',url:`http://127.0.0.1:${server.address().port}/account/login.php`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,autoSubmit:false,maxSteps:4});
  const execImpl=async(_c,_a,prompt)=>{
    const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);
    const link=controls.find(c=>c.label==='Need an account? Click here!');
    const action=link?{action:'click',control:link.id}:{action:'human',message:'fixture stop on registration page'};
    return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{fact:'',message:'',...action},usage:{}})};
  };
  try{
    await runWorker(run,{execImpl,accountRoot:root,allowLocalFixture:true,stateRoot:join(dir,'state')});
    const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
    assert.ok(state.events.some(e=>e.message==='Opened: Need an account? Click here!'),JSON.stringify(state.events.map(e=>e.message)));
    assert.equal(state.events.some(e=>/is not a Next, Continue/.test(e.message)),false);
    assert.equal(registerLoads,1);assert.equal(posts,0);
    assert.equal(Boolean(state.submission_attempted),false);
  }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

// Firefly 13401 (ClearCompany): the passwordless gate offers "Sign in with username and password instead";
// it was rejected as not a Next/Continue button, stranding the role on an emailed link.
test('ClearCompany password-instead link is an account entry', () => {
  assert.ok(authEntry('Sign in with username and password instead'));
  assert.ok(authEntry('Sign in with password'));
  assert.ok(!authEntry('Sign in with Google'));
});
