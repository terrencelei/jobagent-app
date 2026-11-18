import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {runWorker,atomic} from '../src/dashboard-worker.mjs';

for(const kind of ['button','link','unrelated','final','stages'])test(`late posting ${kind} refreshes only preparation navigation without reload or submission`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'late-posting-')),run=join(dir,'run');await mkdir(run);
 let loads=0,posts=0,reads=0;
 const stages=kind==='stages'?3:1,releases=[],renders=[];
 const pending=Array.from({length:stages},(_,i)=>new Promise(r=>releases[i]=r)),ready=Array.from({length:stages},(_,i)=>new Promise(r=>renders[i]=r));
 const server=createServer(async(req,res)=>{
  if(req.method==='POST')posts++;
  if(req.url.startsWith('/controls')){
   const stage=Number(new URL(req.url,'http://fixture.test').searchParams.get('stage'));await pending[stage];
   const target=kind==='stages'?`<a href="${stage<stages-1?'/stage/'+(stage+1):'/apply'}">Continue</a>`:kind==='button'?'<button type="button" onclick="location.href=\'/apply\'">APPLY NOW</button>':kind==='link'?'<a href="/apply">APPLY NOW</a>':kind==='final'?'<button type="submit">Submit application</button>':'<a href="/privacy">Privacy policy</a>';
   res.end(target);return;
  }
  if(req.url.startsWith('/rendered')){renders[Number(new URL(req.url,'http://fixture.test').searchParams.get('stage'))]();res.end('ok');return;}
  if(req.url==='/favicon.ico'){res.end();return;}
  loads++;res.setHeader('Content-Type','text/html');
  if(req.url==='/apply'){res.end('<form><label>First name<input required></label><button type="submit">Submit application</button></form>');return;}
  const stage=Number(req.url.split('/stage/')[1]??0);
  res.end(`<header><a href="#content">Skip</a><button type="button">Close menu</button></header><main id="content"></main><script>fetch("/controls?stage=${stage}").then(r=>r.text()).then(html=>{document.querySelector("main").innerHTML=html;fetch("/rendered?stage=${stage}")})</script>`);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await writeFile(profile,JSON.stringify({answers:{firstName:'Fixture'}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:9911284,company:'Fixture Posting',title:'Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true,maxSteps:12});
 const execImpl=async(_cmd,_args,prompt)=>{
  reads++;const page=JSON.parse(prompt).page,controls=page.frames.flatMap(f=>f.controls);let action;
  if(reads===1||kind==='stages'&&!controls.some(c=>['Continue','Submit application'].includes(c.label))){assert.equal(controls.some(c=>/apply/i.test(c.label)),false);const stage=Number(new URL(page.url).pathname.split('/stage/')[1]??0);releases[stage]();await ready[stage];action={action:'human',message:'Stale page snapshot: job posting loaded after cookies declined, but supplied controls contain only header/footer links. Refresh snapshot to expose APPLY NOW.'};}
  else if(controls.some(c=>['APPLY NOW','Continue'].includes(c.label)))action={action:'click',control:controls.find(c=>['APPLY NOW','Continue'].includes(c.label)).id};
  else {const first=controls.find(c=>c.label==='First name');action=!first.value?{action:'fill',control:first.id,fact:'firstName'}:{action:'review',control:controls.find(c=>c.type==='submit').id};}
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{fact:'',message:'',...action},usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8')),entry=['button','link','stages'].includes(kind);
  assert.equal(state.status,entry?'ready_to_submit':'needs_human',state.message);
  assert.equal(reads,entry?stages*2+2:1);assert.equal(loads,entry?stages+1:1);assert.equal(posts,0);assert.equal(Boolean(state.submission_attempted),false);
  assert.equal(state.events.some(e=>/New form controls appeared/.test(e.message)),entry);
 }finally{releases.forEach(release=>release());await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
