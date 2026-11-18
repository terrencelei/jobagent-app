import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {platformKey,piiClean,sameHint,recordHints,readHints,hintsFor,scoreHints,outcomeDelta,learnFromRun,HINTS_PATH,MAX_ACTIVE} from '../src/site-hints.mjs';
import {decide,finishSiteHints} from '../src/dashboard-worker.mjs';

const tmp=async()=>{const dir=await mkdtemp(join(tmpdir(),'site-hints-'));return {dir,path:join(dir,'site-hints.json')};};
const profile={answers:{firstName:'Pat',lastName:'Example',email:'pat@example.com',phone:'(805) 555-0100',addressCity:'Goleta',phoneCountry:'United States'}};

test('tests never touch the live hints file', ()=>assert.equal(HINTS_PATH,null));

test('a page belongs to its hiring platform, else to the employer domain', ()=>{
 assert.equal(platformKey('https://acme.wd1.myworkdayjobs.com/External/job/x'),'myworkdayjobs.com');
 assert.equal(platformKey('https://careers-acme.icims.com/jobs/1/apply'),'icims.com');
 assert.equal(platformKey('https://careers.acme.com/jobs/1'),'acme.com');
 assert.equal(platformKey('nope'),'');
});

test('the PII gate keeps site knowledge and drops anything personal', ()=>{
 assert.ok(piiClean('The Next button stays disabled until the Country dropdown is chosen; pick United States first.',profile));
 for(const bad of ['Type pat@example.com in the email box','Phone (805) 555-0100 goes in Mobile','Use Pat as the first name',
  'His city Goleta must be typed','Lives at 12 Example Street','Session id a1b2c3d4e5f6g7h8i9j0 must be kept','Enter the password before Next'])
  assert.equal(piiClean(bad,profile),false,bad);
 assert.ok(sameHint('Wait for the Experience page to finish loading before clicking Add','wait for the experience page to finish loading, then click Add'));
});

test('a hint that tells the model to expect approval or flag a field is not stored (Honda 15037, lesson 448)', async()=>{
 const {recordHints,GIVE_UP_HINT}=await import('../src/site-hints.mjs');
 const path=join(await mkdtemp(join(tmpdir(),'hints-')),'site-hints.json');
 const giveUp=["Honda's work-experience and education steps are repeating sections; fill each by position and expect Current Employer, Company Name and Job Title to need approved answers.",
  'Leave the Type of Business select for the applicant to answer.','Flag the From Date field for approval instead of filling it.','Company Name needs approved answers on this site.'];
 for(const text of giveUp)assert.ok(GIVE_UP_HINT.test(text),text);
 const keep=["Honda's work-experience step has date dropdowns whose option lists begin at 1900, so read the year from the list by value.",
  'The Next button stays disabled until the Country dropdown is chosen; pick United States first.'];
 for(const text of keep)assert.equal(GIVE_UP_HINT.test(text),false,text);
 const added=await recordHints('honda.com',[...giveUp,...keep],{path,profile:{}});
 assert.deepEqual(added.map(h=>h.text),keep);
});

test('hints are stored per site, deduplicated, ranked by score, scored by outcome and retired at -3', async()=>{
 const {dir,path}=await tmp();
 try{
  const added=await recordHints('icims.com',['The Apply link opens an iframe; wait for it before reading fields.','the apply link opens an iframe, wait for it before reading fields','Use pat@example.com'],{path,profile});
  assert.equal(added.length,1);
  const [hint]=await hintsFor('https://careers-acme.icims.com/jobs/1',{path,standing:{}});
  assert.equal(hint.text,'The Apply link opens an iframe; wait for it before reading fields.');
  assert.deepEqual(await hintsFor('https://jobs.lever.co/acme/1',{path}),[]);
  assert.equal(outcomeDelta({submitted:true}),1);assert.equal(outcomeDelta({status:'failed'}),-1);assert.equal(outcomeDelta({status:'needs_approval'}),0);
  await scoreHints({'icims.com':[hint.id]},1,{path});
  for(let n=0;n<4;n++)await scoreHints({'icims.com':[hint.id]},-1,{path});
  const stored=(await readHints(path))['icims.com'][0];
  assert.equal(stored.score,-3);assert.equal(stored.status,'retired');assert.equal(stored.wins,1);assert.equal(stored.losses,4);
  assert.deepEqual(await hintsFor('https://careers-acme.icims.com/jobs/1',{path,standing:{}}),[]);
  // A full site retires its weakest hint to make room.
  await recordHints('lever.co',['alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','india','juliet','kilo','lima','mike','november'].slice(0,MAX_ACTIVE+2).map(w=>`${w} ${w}x ${w}y ${w}z`),{path});
  assert.equal((await readHints(path))['lever.co'].filter(h=>h.status==='active').length,MAX_ACTIVE);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('learnFromRun asks the run engine once for the busiest site and keeps only clean hints', async()=>{
 const {dir,path}=await tmp();
 try{
  const calls=[];
  const execImpl=async(command,args,input)=>{calls.push({command,args,input});return {code:0,stderr:'',stdout:JSON.stringify({type:'result',structured_output:{worth_saving:true,hints:['My Experience needs the Add button under Work Experience, not the one under Education.','Email pat@example.com']}})};};
  const history=Array.from({length:6},(_,n)=>({action:'click',control:`Next ${n}`}));
  const result=await learnFromRun({state:{status:'failed',message:'Cannot identify Work Experience Add control'},steps:{'myworkdayjobs.com':5,'acme.com':1},history,events:[{message:'Opened: Apply'}],engine:'claude',model:'claude-haiku-5-5',execImpl,profile,path});
  assert.equal(calls.length,1);assert.ok(calls[0].args.includes('claude-haiku-5-5'));
  assert.ok(!calls[0].args.includes('bypassPermissions'),'distilling needs no tools');
  assert.match(calls[0].input,/myworkdayjobs\.com/);
  assert.deepEqual(result.added.map(h=>h.text),['My Experience needs the Add button under Work Experience, not the one under Education.']);
  // A stopped or skipped run, or one with too few steps, teaches nothing.
  for(const state of [{status:'stopped'},{status:'skipped'}])assert.deepEqual((await learnFromRun({state,steps:{'acme.com':9},history,execImpl,engine:'claude',path})).added,[]);
  assert.deepEqual((await learnFromRun({state:{status:'failed'},steps:{'acme.com':2},history:history.slice(0,2),execImpl,engine:'claude',path})).added,[]);
  assert.equal(calls.length,1);
  // A failing model never throws out of learnFromRun.
  const broken=await learnFromRun({state:{status:'failed'},steps:{'acme.com':9},history,engine:'claude',path,execImpl:async()=>{throw new Error('boom');}});
  assert.deepEqual(broken.added,[]);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('the step model sees siteHints only when the site has some', async()=>{
 const inputs=[];
 const execImpl=async(_c,args,input)=>{inputs.push(args.at(-1)==='-'?input:input);return {code:0,stderr:'',stdout:JSON.stringify({type:'result',structured_output:{action:'click',control:'f0',fact:'',message:''},usage:{}})};};
 await decide({engine:'claude',snap:{},profile:{},bank:{},job:{company:'X'},history:[],context:{siteHints:[{id:'a',text:'Wait for the iframe.'}]},execImpl});
 await decide({engine:'claude',snap:{},profile:{},bank:{},job:{company:'X'},history:[],execImpl});
 assert.deepEqual(JSON.parse(inputs[0]).siteHints,['Wait for the iframe.']);
 assert.equal('siteHints' in JSON.parse(inputs[1]),false);
});

test('finishSiteHints scores at once and learns in a detached helper, never after a stop', async()=>{
 const {dir,path}=await tmp();
 try{
  const [hint]=await recordHints('icims.com',['The Submit button sits below the EEO section; scroll before looking for it.'],{path});
  const spawned=[];const spawnImpl=(cmd,args,opts)=>{spawned.push({args,opts});return {unref(){}};};
  const run=join(dir,'run');await mkdir(run);
  const hintRun={engine:'claude',model:'claude-haiku-5-5',used:{'icims.com':[hint.id]},steps:{'icims.com':6},history:Array.from({length:5},()=>({action:'click',control:'Next'}))};
  await finishSiteHints(run,hintRun,{status:'completed',submitted:true},{path,spawnImpl});
  assert.equal((await readHints(path))['icims.com'][0].score,1);
  assert.equal(spawned.length,1);assert.ok(spawned[0].args[0].endsWith('tools/learn-site-hints.mjs'));assert.equal(spawned[0].opts.detached,true);
  assert.deepEqual(JSON.parse(await readFile(join(run,'site-hints-run.json'),'utf8')).steps,{'icims.com':6});
  await finishSiteHints(run,hintRun,{status:'stopped'},{path,spawnImpl});
  assert.equal(spawned.length,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
