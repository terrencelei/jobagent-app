import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {requiredContacts,declineOptionalCookies} from '../src/required-contacts.mjs';
import {runWorker,atomic} from '../src/dashboard-worker.mjs';

const answers={firstName:'Fixture',lastName:'Applicant',email:'fixture@example.test',phone:'2025550100'};
test('required contact recovery uses exact plain labels and saved facts only',()=>{
 const control={id:'contact',label:'*\n First name',type:'text',inForm:true,required:true,value:''};
 const snap=c=>({frames:[{frameIndex:0,controls:[c]}]});
 assert.equal(requiredContacts(snap(control),{answers})[0].value,'Fixture');
 assert.equal(requiredContacts(snap({...control,label:'Email address *',type:'email'}),{answers})[0].value,answers.email);
 for(const change of [{inForm:false},{required:false},{value:'Retained'},{type:'textarea'},{type:'checkbox'},{type:'password'},{combobox:true},{label:'Phone SMS consent'},{label:'Describe your first name'},{label:'Unknown personal fact'}])assert.equal(requiredContacts(snap({...control,...change}),{answers}).length,0);
 assert.deepEqual(requiredContacts(snap(control),{answers:{}}),[]);
});

test('cookie dismissal ignores unrelated choices and ambiguous banners',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent('<form><p>Cookies preference</p><button>Decline all</button><button>Accept all</button></form>');
  assert.equal(await declineOptionalCookies(page),false);
  const banner='<aside><p>We use cookies to personalize your experience.</p><button>Accept all</button><button>Decline all</button></aside>';
  await page.setContent(banner+banner);assert.equal(await declineOptionalCookies(page),false);
  await page.setContent('<aside><p>We use cookies.</p><button>Accept all</button><button onclick="this.closest(\'aside\').remove()">Decline all</button></aside>');
  assert.equal(await declineOptionalCookies(page),true);assert.equal(await page.locator('aside').count(),0);
 }finally{await browser.close();}
});

test('Oracle-style click-to cookie consent reveals authentication without accepting or submitting',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<form><label>Email Address<input type="email" required></label><button type="submit">Continue</button></form><aside role="dialog"><p>When you visit our website, we store cookies on your browser. Strictly Necessary cookies support logging in.</p><button onclick="document.body.dataset.accepted='yes'">CLICK TO ACCEPT ALL COOKIES</button><button onclick="this.closest('aside').remove()">CLICK TO DECLINE ALL COOKIES</button></aside>`);
  assert.equal(await declineOptionalCookies(page),true);
  assert.equal(await page.locator('aside').count(),0);
  assert.equal(await page.locator('body').getAttribute('data-accepted'),null);
  assert.equal(await page.getByLabel('Email Address').inputValue(),'');
  for(const label of ['CLICK TO DECLINE ALL COOKIES AND APPLY','Do not decline all cookies']){
   await page.setContent(`<aside><p>We store cookies.</p><button>CLICK TO ACCEPT ALL COOKIES</button><button>${label}</button></aside>`);
   assert.equal(await declineOptionalCookies(page),false);
  }
  await page.setContent(`<form><p>We store cookies.</p><button>CLICK TO ACCEPT ALL COOKIES</button><button>CLICK TO DECLINE ALL COOKIES</button></form>`);
  assert.equal(await declineOptionalCookies(page),false);
 }finally{await browser.close();}
});

for(const missing of [false,true])test(`premature review recovers saved Workable-style contacts, unknown required fact=${missing}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'required-contacts-')),run=join(dir,'run');await mkdir(run);
 let posts=0,reads=0;
 const server=createServer((req,res)=>{
  if(req.method==='POST')posts++;
  res.setHeader('Content-Type','text/html');
  res.end(`<style>#shade{position:fixed;inset:0;background:#333e;z-index:5}aside{position:fixed;bottom:0;background:white;z-index:6;width:100%}</style><div id="shade"></div><form method="post">${[['First name','text'],['Last name','text'],['Email','email'],['Phone','tel']].map(([label,type],i)=>`<label for="c${i}"><span>*</span><br>${label}</label><input id="c${i}" type="${type}" required>`).join('')}${missing?'<label>Unknown personal fact<input required name="unknown"></label>':''}<button type="submit">Submit application</button></form><aside><p>This website uses cookies to improve your experience.</p><button>Cookies settings</button><button onclick="document.body.dataset.accepted='yes'">${missing?'CLICK TO ACCEPT ALL COOKIES':'Accept all'}</button><button onclick="document.getElementById('shade').remove();this.closest('aside').remove()">${missing?'CLICK TO DECLINE ALL COOKIES':'Decline all'}</button></aside>`);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await writeFile(profile,JSON.stringify({answers}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:missing?9910574:9910573,company:'Fixture',title:'Mechanical Engineer I',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,maxSteps:4,autoSubmit:missing});
 const execImpl=async(_command,_args,prompt)=>{
  reads++;const snap=JSON.parse(prompt).page,controls=snap.frames.flatMap(f=>f.controls);
  assert.equal(controls.some(c=>/^(?:CLICK TO )?Decline all(?: COOKIES)?$/i.test(c.label)),false,'cookie banner should be dismissed before decision');
  const target=controls.find(c=>c.type==='submit');
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:'review',control:target.id,fact:'',message:''},usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,missing?'failed':'ready_to_submit',state.message);
  assert.equal(reads,2);assert.equal(posts,0);assert.ok(state.events.some(e=>e.message==='Declined optional cookies'));
  assert.ok(state.events.some(e=>e.message==='Filled saved required contact details before review'));
  assert.equal(Boolean(state.submission_attempted),false);
  if(missing){assert.match(state.message,/Unknown personal fact/);assert.equal(state.review,null);}
  else for(const value of Object.values(answers))assert.ok(state.review.answers.some(a=>a.value===value));
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('Oracle CX "DECLINE COOKIES" banner is declined (Howmet 13039)',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<div role="dialog"><p>Cookie Settings <a href="#">Learn more</a></p><button onclick="document.body.dataset.accepted='yes'">ACCEPT ALL COOKIES</button><button onclick="this.closest('div').remove()">DECLINE COOKIES</button></div>`);
  assert.equal(await declineOptionalCookies(page),true);
  assert.equal(await page.locator('[role=dialog]').count(),0);
  assert.equal(await page.locator('body').getAttribute('data-accepted'),null);
 }finally{await browser.close();}
});

test('acceptTerms on a cookie button is sent back, not a failed run (Howmet 13039)',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cookie-terms-')),run=join(dir,'run');await mkdir(run);
 let posts=0,reads=0;
 const server=createServer((req,res)=>{
  if(req.method==='POST')posts++;
  res.setHeader('Content-Type','text/html');
  res.end(`<form method="post"><label>First name<input name="first"></label><button type="submit">Submit application</button></form><aside><p>Cookie Settings</p><button onclick="document.body.dataset.accepted='yes'">ACCEPT ALL COOKIES</button></aside>`);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await writeFile(profile,JSON.stringify({answers}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:9913039,company:'Fixture',title:'Process Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,maxSteps:4});
 const execImpl=async(_command,_args,prompt)=>{
  const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);
  const action=reads++===0?{action:'fill',control:controls.find(c=>/ACCEPT ALL COOKIES/.test(c.label)).id,fact:'acceptTerms',message:''}:{action:'review',control:controls.find(c=>c.type==='submit').id,fact:'',message:''};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:action,usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.doesNotMatch(state.message??'',/Only a required terms checkbox/);
  assert.ok(state.events.some(e=>/cookie banner choice/.test(e.message)));
  assert.ok(reads>=2);assert.equal(posts,0);assert.equal(Boolean(state.submission_attempted),false);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('a labelled cookie consent modal with its own form is declined (Waymo 13548)',async()=>{
  const browser=await chromium.launch({headless:true});const page=await browser.newPage();
  await page.setContent(`<form id="app"><label>Declaration<input type="checkbox"></label></form><div role="dialog" aria-modal="true" aria-label="Cookie consent" class="consent-modal"><p>We use cookies.</p><form><input type="checkbox" checked><button type="submit">Manage Cookies</button></form><button onclick="this.closest('[role=dialog]').remove()">I do not accept</button><button onclick="document.body.dataset.accepted='yes'">I accept</button></div>`);
  assert.equal(await declineOptionalCookies(page),true);
  assert.equal(await page.locator('[role=dialog]').count(),0);
  assert.equal(await page.evaluate(()=>document.body.dataset.accepted),undefined);
  await page.setContent(`<div role="dialog" aria-label="Your profile"><p>We use cookies.</p><form><input></form><button>I do not accept</button><button>I accept</button></div>`);
  assert.equal(await declineOptionalCookies(page),false,'only a dialog labelled as cookie consent');
  await browser.close();
});
