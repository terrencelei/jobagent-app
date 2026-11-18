import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {signInLandingPage} from '../src/posting-navigation.mjs';
import {runWorker,atomic} from '../src/dashboard-worker.mjs';

// ArcBest 12717: arcbest.avature.net redirected to careers.arcb.com; after the new account's
// "Log in" the site opened /careersmarketplace/Profile, not the application.
const job='https://arcbest.avature.net/careersmarketplace/JobDetail?id=29813&source=Indeed';
const landed='https://careers.arcb.com/careersmarketplace/JobDetail?id=29813&source=Indeed';

test('a candidate profile/home page on the posting site after sign-in is recognised',()=>{
 assert.equal(signInLandingPage('https://careers.arcb.com/careersmarketplace/Profile',[job,landed]),true);
 assert.equal(signInLandingPage('https://careers.arcb.com/careersmarketplace/Home/',[job,landed]),true);
 assert.equal(signInLandingPage('https://arcbest.avature.net/careersmarketplace/Profile',job),true);
 // The posting, its application and anything off the posting's site are not landing pages.
 assert.equal(signInLandingPage(landed,[job,landed]),false);
 assert.equal(signInLandingPage('https://careers.arcb.com/careersmarketplace/ApplicationMethods?jobId=29813',[job,landed]),false);
 assert.equal(signInLandingPage('https://careers.arcb.com/careersmarketplace/Application?jobId=29813',[job,landed]),false);
 assert.equal(signInLandingPage('https://evil.example/Profile',[job,landed]),false);
 assert.equal(signInLandingPage('http://careers.arcb.com/careersmarketplace/Profile',[job,landed]),false);
 assert.equal(signInLandingPage('not a url',[job,landed]),false);
});

test('after a sign-in that lands on the profile page the worker reopens the posting and applies',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'avature-profile-')),run=join(dir,'run'),root=join(dir,'account');
 await mkdir(run);await mkdir(join(root,'private'),{recursive:true});
 let detailLoads=0,profileLoads=0,formLoads=0,posts=0;
 const server=createServer((req,res)=>{
  const signedIn=/session=1/.test(req.headers.cookie??'');
  if(req.method==='POST'){posts++;let body='';req.on('data',c=>body+=c);req.on('end',()=>{res.writeHead(302,{'Set-Cookie':'session=1; Path=/',Location:'/careersmarketplace/Profile'});res.end();});return;}
  res.setHeader('Content-Type','text/html');
  if(req.url==='/favicon.ico')return res.end();
  if(req.url.startsWith('/careersmarketplace/JobDetail')){detailLoads++;return res.end('<h1>Test and Reliability Engineer I</h1><p>Fort Smith, AR</p><a href="/careersmarketplace/ApplicationMethods?jobId=29813">Apply</a>');}
  if(req.url.startsWith('/careersmarketplace/ApplicationMethods')){
   if(!signedIn){res.writeHead(302,{Location:'/careersmarketplace/Login?jobId=29813'});return res.end();}
   formLoads++;return res.end('<h1>Application</h1><form method="post"><label>Phone *<input required></label><button type="submit">Submit</button></form>');
  }
  if(req.url.startsWith('/careersmarketplace/Login'))return res.end('<h1>Sign in</h1><form method="post" action="/careersmarketplace/Login"><label>Email<input type="email" required></label><label>Password<input type="password" required></label><button type="submit">Log in</button></form>');
  if(req.url.startsWith('/careersmarketplace/Profile')){profileLoads++;return res.end('<h1>Fixture Applicant</h1><p>Resume.pdf</p><a href="/careersmarketplace/Home">Home</a><a href="/careersmarketplace/SearchJobs">OPEN JOBS</a><a href="/careersmarketplace/JobApplications">Job Applications</a><a href="/careersmarketplace/EditProfile">Edit profile</a>');}
  res.statusCode=404;res.end('missing');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');
 await writeFile(profile,JSON.stringify({answers:{email:'fixture@example.test',firstName:'Fixture'}}));await writeFile(resume,'fixture');
 await writeFile(join(root,'private','credentials.json'),JSON.stringify({fixture:{host:'127.0.0.1',email:'fixture@example.test',password:'synthetic-local-only'}}));
 await atomic(join(run,'request.json'),{job:{id:9912717,company:'Fixture ArcBest',title:'Test and Reliability Engineer I',url:`${base}/careersmarketplace/JobDetail?id=29813&source=Indeed`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,autoSubmit:false,maxSteps:12});
 const modelPages=[];let passwordFilled=false;
 const execImpl=async(_c,_a,prompt)=>{
  const page=JSON.parse(prompt).page;const controls=page.frames.flatMap(f=>f.controls);modelPages.push(page.url);
  const by=label=>controls.find(c=>c.label===label);
  let action;
  if(by('Apply'))action={action:'click',control:by('Apply').id};
  else if(by('Password')){const email=by('Email');if(email&&!email.value)action={action:'fill',control:email.id,fact:'email'};else if(!passwordFilled){passwordFilled=true;action={action:'fill',control:by('Password').id,fact:'accountPassword'};}else action={action:'click',control:by('Log in').id};}
  else if(by('Phone *'))action={action:'human',message:'fixture stop on the application form'};
  else action={action:'human',message:`fixture: no application controls on ${page.url}`};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{fact:'',message:'',...action},usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,accountRoot:root,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));const messages=state.events.map(e=>e.message);
  assert.ok(messages.some(m=>/opened your candidate profile instead of the application; reopening the posting/.test(m)),JSON.stringify(messages));
  assert.ok(messages.includes('Signing in: Log in'),JSON.stringify(messages));
  assert.equal(messages.filter(m=>m==='Opened: Apply').length,2,JSON.stringify(messages));
  assert.ok(messages.some(m=>/fixture stop on the application form/.test(m)),JSON.stringify(messages));
  assert.equal(modelPages.some(u=>/\/Profile/.test(u)),false,'the model was never asked about the profile page: '+JSON.stringify(modelPages));
  assert.equal(detailLoads,2);assert.equal(profileLoads,1);assert.equal(formLoads,1);assert.equal(posts,1);
  assert.equal(Boolean(state.submission_attempted),false);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
