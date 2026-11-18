import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createServer} from 'node:http';
import {runWorker} from '../src/dashboard-worker.mjs';
import {detachedControlError} from '../src/detached-control.mjs';
// Piper 13343 (iRecruit): "Save/Next" posts the section by AJAX and swaps the section's HTML for the
// server's re-render seconds later. The data-ja-control tags of the last snapshot went with the old
// nodes, so the next fill waited for `[data-ja-control="f0c18"]` and the run failed with a Playwright
// timeout. A control that left the page is re-read, not fatal.
const section=`<label>First Name<input name="f"></label><label>Last Name<input name="l"></label><button type="submit">Submit application</button>`;
// The server's re-render carries none of the snapshot's data-ja-control tags, as on iRecruit.
const form=`<form method="post"><div id="section">${section}</div></form><script>
 const template=${JSON.stringify(section)};let swapped=false;
 document.addEventListener('input',e=>{if(e.target.name==='l'&&!swapped){swapped=true;document.getElementById('section').innerHTML=template;}});
</script>`;
test('a control replaced by a page re-render after the snapshot is read again instead of failing the run',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rerender-')),runDir=join(dir,'run'),stateRoot=join(dir,'state');await mkdir(runDir);await mkdir(stateRoot);
 let posts=0;const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');if(req.method==='POST'){posts++;return res.end('<h1>Thank you for applying!</h1>');}res.end(form);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 const profilePath=join(dir,'profile.json'),resumePath=join(dir,'resume.pdf');
 await writeFile(profilePath,JSON.stringify({answers:{firstName:'Fixture',lastName:'Applicant'},documents:{}}));await writeFile(resumePath,'x');
 await writeFile(join(runDir,'request.json'),JSON.stringify({job:{id:999994,company:'Fixture',title:'Engineer',url},profilePath,resumePath,engine:'claude',model:'claude-opus-5-5',parkQuestions:true,autoSubmit:true}));
 const execImpl=async(_c,_a,prompt)=>{const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);
  const first=controls.find(c=>c.label==='First Name'&&!c.value),last=controls.find(c=>c.label==='Last Name'&&!c.value),submit=controls.find(c=>c.type==='submit');
  const action=first?{action:'fill',control:first.id,fact:'firstName'}:last?{action:'fill',control:last.id,fact:'lastName'}:{action:'review',control:submit.id,fact:''};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{...action,message:''},usage:{}})};};
 try{
  await runWorker(runDir,{execImpl,stateRoot,allowLocalFixture:true});
  const state=JSON.parse(await readFile(join(runDir,'state.json'),'utf8'));const messages=state.events.map(e=>e.message);
  assert.ok(['submitted_pending_receipt','completed'].includes(state.status),state.message);
  assert.ok(messages.some(m=>/Retrying: Last Name left the page while it was re-rendering/.test(m)),JSON.stringify(messages));
  assert.ok(!messages.some(m=>/locator\.(fill|inputValue): Timeout/.test(m)),JSON.stringify(messages));
  assert.equal(posts,1,'submitted once after the re-render');
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('detachedControlError recognises a vanished data-ja-control tag and leaves other errors alone',()=>{
 assert.equal(detachedControlError(new Error(`locator.fill: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('[data-ja-control="f0c18"]')\n`)),true);
 assert.equal(detachedControlError(new Error('locator.inputValue: Element is not attached to the DOM')),true);
 assert.equal(detachedControlError(new Error('The page did not retain the supplied answer')),false);
 assert.equal(detachedControlError(new Error(`locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('button.submit')\n`)),false);
});
