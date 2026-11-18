// Safran 13178 (2026-10-23): the cookie banner's "Reject All" reloaded the posting into Cloudflare's
// "Sorry, you have been blocked" page inside the first step. The step model asked for a human and the
// run parked as needs_human instead of taking the cooldown path. The block page is now recognised
// when a human decision arrives, so the loop start refreshes once and stops with the cooldown marker.
// The settings file shortens the refresh pause; it must be named before the worker is imported.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
const settingsDir=await mkdtemp(join(tmpdir(),'cloudflare-settings-'));
process.env.JOBAGENT_SETTINGS=join(settingsDir,'settings.json');
await writeFile(process.env.JOBAGENT_SETTINGS,JSON.stringify({effective:{'throttle.refresh_pause_seconds':0}}));
const {runWorker,atomic}=await import('../src/dashboard-worker.mjs');
const {THROTTLED}=await import('../src/throttle.mjs');

const BLOCK='<h1>Sorry, you have been blocked</h1><h2>You are unable to access safran-group.com</h2><p>This website is using a security service to protect itself from online attacks.</p><p>Cloudflare Ray ID: a4f4df4c4cb9fca7</p>';
const POSTING=`<div><p>We value your privacy</p><p>We use cookies to enhance your browsing experience.</p><button onclick="location.reload()">Reject All</button><button>Accept All</button></div><h1>Systems Engineer</h1><a href="/jobapplication">Apply</a>`;

test('a Cloudflare block page that appears during a step takes the cooldown path, not Needs help',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cloudflare-block-'));let reads=0,calls=0;
 const server=createServer((_req,res)=>{reads++;res.setHeader('Content-Type','text/html');if(reads===1)return res.end(POSTING);res.statusCode=403;res.setHeader('Content-Type','text/html');res.end(`<title>Attention Required! | Cloudflare</title>${BLOCK}`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const run=join(dir,'run');await mkdir(run);const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await writeFile(profile,JSON.stringify({answers:{}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:13178,company:'SAFRAN',title:'Systems Engineer',url:`http://127.0.0.1:${server.address().port}/jobs/systems-engineer-177296`},profilePath:profile,resumePath:resume,parkQuestions:true,headlessOnly:true,engine:'claude'});
 const execImpl=async()=>{calls++;return{code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:'human',control:'',fact:'',message:'Technical block, not a form step: the site is showing a Cloudflare page in place of the job posting.'},usage:{}})};};
 try{
  await runWorker(run,{execImpl,stateRoot:join(dir,'state'),allowLocalFixture:true});
  const s=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(s.status,'blocked',s.message);
  assert.ok(s.message.startsWith(THROTTLED),s.message);
  assert.match(s.message,/Cloudflare block page/);
  assert.ok(s.events.some(e=>/Declined optional cookies/.test(e.message)),'the banner click is what reloaded into the block');
  assert.ok(s.events.some(e=>/turned into a Cloudflare block page during this step/.test(e.message)));
  assert.equal(calls,1,'the step model is not asked again about a block page');
  assert.ok(reads>=3,'posting, the reload after Reject All, and the one refresh');
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});await rm(settingsDir,{recursive:true,force:true});}
});
