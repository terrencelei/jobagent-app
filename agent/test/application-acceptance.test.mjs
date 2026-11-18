import test from 'node:test';
import assert from 'node:assert/strict';
import {webpageAcceptance,verifiedWebpageAcceptance,collectWebpageAcceptance} from '../src/application-acceptance.mjs';
const job={id:42,company:'Fixture Works',title:'Engineer',url:'https://boards.example.test/fixture/jobs/42'};
const base={job,url:'https://boards.example.test/fixture/thank-you',submittedAt:'2026-10-15T12:00:00Z',now:'2026-10-15T12:00:10Z'};
test('positive employer webpage acknowledgements count independently of an email',()=>{
 for(const text of ['Thank you for applying!','Your application has been submitted.','Your application was successfully submitted.','Your application has successfully been submitted.','We have received your application.']){
  const evidence=webpageAcceptance({...base,text});assert.ok(evidence,text);assert.equal(evidence.source,'webpage');assert.equal(verifiedWebpageAcceptance(evidence,job),evidence);
 }
});
test('a click, general interest text, another employer host, code gate, CAPTCHA, and form errors are insufficient',()=>{
 for(const override of [{text:'Submitted'},{text:'Thank you for your interest in Fixture Works'},{text:'Your application has been submitted',url:'https://unrelated.example/thanks'},{text:'Thank you for applying! Enter your security code'},{text:'Thank you for applying!',challengeVisible:true},{text:'Thank you for applying!',submitVisible:true},{text:'Thank you for applying!',errors:['Required answer']},{text:'Thank you for applying!',submittedAt:undefined}])assert.equal(webpageAcceptance({...base,...override}),null,JSON.stringify(override));
});
test('Workday status cards must match the current requisition',()=>{
 const wd={...job,url:'https://fixture.wd5.myworkdayjobs.com/en-US/Jobs/job/Engineer_JR12345'};
 const e=webpageAcceptance({...base,job:wd,url:wd.url,text:'Engineer JR12345 Application Under Review'});
 assert.ok(e);assert.equal(verifiedWebpageAcceptance(e,wd),e);
 assert.equal(webpageAcceptance({...base,job:wd,url:wd.url,text:'Other job JR98765 Application Under Review'}),null);
 assert.equal(verifiedWebpageAcceptance({...e,requisition:'JR98765'},wd),null);
});
test('evidence is tied to its exact job, timestamp, and text digest',()=>{
 const evidence=webpageAcceptance({...base,text:'Thank you for applying!'});
 for(const override of [{jobId:43},{applicationUrl:job.url+'/another'},{company:'Other'},{pageTextSha256:'x'.repeat(64)},{submittedAt:'2026-10-16T12:00:00Z'}])assert.equal(verifiedWebpageAcceptance({...evidence,...override},job),null);
 assert.equal(verifiedWebpageAcceptance({...evidence,jobId:'jobagent-42'},job)?.source,'webpage');
});
test('browser collection reads visible state, captures durable screenshot evidence, and rejects a live form',async()=>{
 const {chromium}=await import('playwright');const {mkdtemp,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'web-acceptance-'));const browser=await chromium.launch({headless:true});
 try{const page=await browser.newPage();await page.goto('about:blank');await page.setContent('<h1>Thank you for applying!</h1>');
  const localJob={...job,url:'about:blank'}; // sameHost intentionally requires a genuine host.
  assert.equal(await collectWebpageAcceptance(page,localJob,{submittedAt:new Date().toISOString()}),null);
  await page.route('https://boards.example.test/**',r=>r.fulfill({body:'<h1>Thank you for applying!</h1>',contentType:'text/html'}));await page.goto(job.url);
  const screenshotPath=join(dir,'confirmation.png');const e=await collectWebpageAcceptance(page,job,{submittedAt:new Date().toISOString(),screenshotPath});
  assert.ok(e);assert.equal(e.screenshotSha256.length,64);assert.ok((await readFile(screenshotPath)).length);
  await page.setContent('<p>Thank you for applying!</p><button>Submit application</button>');assert.equal(await collectWebpageAcceptance(page,job,{submittedAt:new Date().toISOString()}),null);
 }finally{await browser.close();await rm(dir,{recursive:true,force:true});}
});

test('Greenhouse host migration requires the same employer board and posting',()=>{
 const gh={...job,url:'https://boards.greenhouse.io/fixture/jobs/42'};
 const e=webpageAcceptance({...base,job:gh,url:'https://job-boards.greenhouse.io/fixture/jobs/42/confirmation',text:'Your application has been received'});assert.ok(e);assert.ok(verifiedWebpageAcceptance(e,gh));
 for(const url of ['https://job-boards.greenhouse.io/other/jobs/42/confirmation','https://job-boards.greenhouse.io/fixture/jobs/43/confirmation'])assert.equal(webpageAcceptance({...base,job:gh,url,text:'Your application has been received'}),null);
});

test('dashboard worker completes once on an employer success page without a mailbox call',async()=>{
 const {runWorker}=await import('../src/dashboard-worker.mjs');const {createServer}=await import('node:http');const {mkdtemp,mkdir,writeFile,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'worker-web-acceptance-')),run=join(dir,'run');await mkdir(run);let submissions=0;
 const server=createServer((req,res)=>{res.setHeader('content-type','text/html');if(req.url.startsWith('/submit')){submissions++;return res.end('<h1>Thank you for applying!</h1><p>Your application has been received.</p>');}res.end('<form action="/submit"><label>Name<input name="name" value="Fixture Applicant"></label><button type="submit">Submit application</button></form>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profilePath=join(dir,'profile.json'),resumePath=join(dir,'resume.pdf');await writeFile(profilePath,JSON.stringify({answers:{}}));await writeFile(resumePath,'fixture');
 await writeFile(join(run,'request.json'),JSON.stringify({job:{id:42,company:'Fixture Works',title:'Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath,resumePath,autoSubmit:true,parkQuestions:true,engine:'claude'}));
 const execImpl=async(_c,_args,prompt)=>{const input=JSON.parse(prompt);const control=input.page.frames.flatMap(f=>f.controls).find(c=>c.type==='submit');return {code:0,stdout:JSON.stringify({structured_output:{action:'review',control:control.id,fact:'',message:''},usage:{}}),stderr:''};};
 try{await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));assert.equal(state.status,'completed');assert.equal(state.submitted,true);assert.equal(state.receiptSource,'webpage');assert.equal(submissions,1);assert.ok(state.webpageEvidence.screenshotSha256);const durable=JSON.parse(await readFile(join(dir,'state/jobagent-42.json'),'utf8'));assert.equal(durable.status,'submitted');assert.equal(durable.receiptSource,'webpage');}
 finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
