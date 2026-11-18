import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {ashbyApplicationPage,waitForAshbyForm} from '../src/ashby-readiness.mjs';
test('only Ashby application pages require its system fields',()=>{
 assert.equal(ashbyApplicationPage('https://jobs.ashbyhq.com/whoop/job/application'),true);
 assert.equal(ashbyApplicationPage('https://jobs.ashbyhq.com/cobot/job/application/'),true);
 assert.equal(ashbyApplicationPage('https://jobs.ashbyhq.com/cobot/job'),false);
 assert.equal(ashbyApplicationPage('https://example.com/cobot/job/application'),false);
});
test('waits for asynchronous application fields rather than the shell or autofill upload',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.route('http://localhost/fixture',route=>route.fulfill({body:'<body></body>',contentType:'text/html'}));
  await page.goto('http://localhost/fixture');
  await page.setContent('<p>Fetching application form</p><input type="file"><script>setTimeout(()=>{document.body.innerHTML=\'<input id="_systemfield_name"><input id="_systemfield_email" type="email">\';},300)</script>');
  assert.equal(await waitForAshbyForm(page,{timeout:2000}),true);
  await page.setContent('<p>Fetching application form</p><input type="file">');
  assert.equal(await waitForAshbyForm(page,{timeout:100}),false);
 }finally{await browser.close();}
});

test('Ashby Yes/No and radio fields retain question context and verified choices',async()=>{
 const {snapshot,fillAshbyChoice,isFinalControl}=await import('../src/dashboard-worker.mjs');
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.route('http://localhost/fixture',route=>route.fulfill({body:'<body></body>',contentType:'text/html'}));
  await page.goto('http://localhost/fixture');
  await page.setContent(`<form>
   <div class="ashby-application-form-field-entry" data-field-path="sponsorship"><label class="ashby-application-form-question-title _required_fixture">Do you require sponsorship?</label><div class="ashby-application-form-input-yesno"><button data-option="yes" aria-pressed="false" onclick="event.preventDefault();this.parentElement.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===this)))">Yes</button><button data-option="no" aria-pressed="false" onclick="event.preventDefault();this.parentElement.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===this)))">No</button><input type="checkbox" style="display:none"></div></div>
   <div data-field-entry-id="location" data-field-path="location"><fieldset class="ashby-application-form-input-radio-group"><label class="ashby-application-form-question-title _required_fixture">Where can you work?</label><label><input type="radio" name="place" value="onsite">Onsite</label><label><input type="radio" name="place" value="relocate">Relocate</label></fieldset></div>
   <div data-field-entry-id="availability" data-field-path="availability"><fieldset class="ashby-application-form-input-checkbox-group"><label class="ashby-application-form-question-title _required_fixture">How soon can you start?</label><label><input type="checkbox" value="now">Immediately</label><label><input type="checkbox" value="later">More than two weeks</label></fieldset></div>
   <button>Submit Application</button></form>`);
  let controls=(await snapshot(page)).frames[0].controls;
  const choices=controls.filter(c=>c.type==='choice');
  assert.equal(choices.length,3);assert.ok(choices.every(c=>c.required&&!isFinalControl(c)));
  assert.ok(!controls.some(c=>c.label==='Yes'||c.label==='No'));
  assert.deepEqual(choices[0].options.map(o=>o.label),['Yes','No']);assert.equal(choices[0].value,'');
  for(const [choice,value] of [[choices[0],'No'],[choices[1],'Relocate'],[choices[2],'More than two weeks']]) await fillAshbyChoice(page.mainFrame(),page.locator(`[data-ja-control="${choice.id}"]`),value);
  controls=(await snapshot(page)).frames[0].controls;
  assert.equal(controls.find(c=>c.name==='sponsorship').value,'No');
  assert.equal(controls.find(c=>c.name==='location').value,'Relocate');
  assert.equal(controls.find(c=>c.name==='availability').value,'More than two weeks');
 }finally{await browser.close();}
});


test('a visible post-submit CAPTCHA is distinguished from a passive or hidden widget',async()=>{
 const {visibleApplicationChallenge}=await import('../src/application-challenge.mjs');
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent('<iframe title="reCAPTCHA" style="width:300px;height:80px"></iframe><iframe title="recaptcha challenge expires in two minutes" style="display:none;width:300px;height:500px"></iframe>');
  assert.equal(await visibleApplicationChallenge(page),false);
  await page.locator('iframe').nth(1).evaluate(el=>el.style.display='block');
  assert.equal(await visibleApplicationChallenge(page),true);
 }finally{await browser.close();}
});

test('Submit followed by a CAPTCHA parks for help and preserves duplicate-submission protection',async()=>{
 const {runWorker,atomic}=await import('../src/dashboard-worker.mjs');
 const {mkdtemp,mkdir,writeFile,readFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {createServer}=await import('node:http');
 const dir=await mkdtemp(join(tmpdir(),'ashby-challenge-')),run=join(dir,'run');await mkdir(run);
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<form onsubmit="event.preventDefault();window.submits=(window.submits||0)+1;document.getElementById('captcha').hidden=false"><label>Name<input value="Fixture" required></label><button>Submit Application</button></form><iframe id="captcha" title="recaptcha challenge expires in two minutes" hidden style="width:300px;height:500px"></iframe>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');
 await writeFile(profile,JSON.stringify({answers:{fullName:'Fixture'}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:987,company:'Fixture',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,autoSubmit:true});
 const execImpl=async(_command,_args,prompt)=>{const controls=JSON.parse(prompt).page.frames[0].controls;const submit=controls.find(c=>c.label==='Submit Application');return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:'review',control:submit.id,fact:'',message:''},usage:{}})};};
 try{
  await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,'needs_human',state.message);assert.equal(state.submission_attempted,true);assert.equal(state.submitted,false);
  assert.match(state.message,/CAPTCHA/);
  const durable=JSON.parse(await readFile(join(dir,'state','jobagent-987.json'),'utf8'));
  assert.equal(durable.status,'awaiting_human_submit');
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('a removed Ashby job is recognized at once instead of waiting for a form (Skydio 1309, Applied Intuition 782)',async()=>{
 const {ashbyJobNotFound}=await import('../src/ashby-readiness.mjs');
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.route('http://localhost/fixture',route=>route.fulfill({body:'<body></body>',contentType:'text/html'}));
  await page.goto('http://localhost/fixture');
  await page.setContent('<h1>Job not found</h1><p>The job you requested was not found.</p><a>View all open positions</a>');
  const started=Date.now();
  assert.equal(await waitForAshbyForm(page,{timeout:5000}),false);
  assert.ok(Date.now()-started<3000,'stops waiting early');
  assert.equal(await ashbyJobNotFound(page),true);
  await page.setContent('<p>Fetching application form</p>');
  assert.equal(await ashbyJobNotFound(page),false);
  await page.setContent('<h1>Mechanical Engineer</h1><p>Job not found errors are handled by our tooling.</p>');
  assert.equal(await ashbyJobNotFound(page),false);
 }finally{await browser.close();}
});
