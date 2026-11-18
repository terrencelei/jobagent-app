// Opens a real Chrome window, so it runs only on request: HUMAN_CHROME_E2E=1 node --test test/human-finish-worker.test.mjs
// It uses the real finish-yourself profile (private/human-chrome, the same one his "Finish in my Chrome" runs use):
// run it only when no handover window is open, and never in CI.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {atomic,runWorker} from '../src/dashboard-worker.mjs';

test('finish-in-my-Chrome fills the form, never presses Submit, and leaves the filled window to him',{skip:process.env.HUMAN_CHROME_E2E!=='1'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'human-finish-')),run=join(dir,'run');await mkdir(run);let posted=false;
 const server=createServer((req,res)=>{if(req.method==='POST')posted=true;res.setHeader('Content-Type','text/html');
  res.end('<form method="post"><label for="fn">First Name</label><input id="fn" name="fn" required><button type="submit">Submit Application</button></form>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await writeFile(profile,JSON.stringify({answers:{firstName:'Alex'}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:984,company:'Fixture',url:`http://127.0.0.1:${server.address().port}/apply`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,autoSubmit:true,humanFinish:true,headlessOnly:true});
 const execImpl=async(_c,_a,prompt)=>{const controls=JSON.parse(prompt).page.frames[0].controls;const fn=controls.find(c=>c.label==='First Name');const submit=controls.find(c=>/Submit/.test(c.label));
  const action=fn&&!fn.value?{action:'fill',control:fn.id,fact:'firstName',message:''}:{action:'review',control:submit.id,fact:'',message:''};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:action,usage:{}})};};
 try{
  await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.phase,'human_submit');assert.equal(posted,false,'the worker must never press Submit');
  const durable=JSON.parse(await readFile(join(dir,'state','jobagent-984.json'),'utf8'));assert.equal(durable.status,'awaiting_human_submit');
  // The window is still open, filled, and nothing is attached to it.
  const endpoint=(await readFile(join(process.cwd(),'private/human-chrome/jobagent-endpoint'),'utf8')).trim();
  const pages=await (await fetch(`${endpoint}/json/list`)).json();
  const tab=pages.find(p=>p.type==='page'&&p.url.includes('/apply'));assert.ok(tab,'his tab stays open');
  const b=await chromium.connectOverCDP(endpoint);
  const page=b.contexts()[0].pages().find(p=>p.url().includes('/apply'));assert.equal(await page.inputValue('#fn'),'Alex');
  assert.equal(await page.evaluate(()=>navigator.webdriver),false);await page.close();await b.close();
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
