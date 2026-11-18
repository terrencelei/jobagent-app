import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runWorker} from '../src/dashboard-worker.mjs';
import {chromium} from 'playwright';
import {monitorGreenhouseUploads} from '../src/greenhouse-upload.mjs';

for(const mode of ['delayed','configuration-error','upload-error'])test(`Greenhouse upload verifies employer acceptance: ${mode}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'greenhouse-upload-')),run=join(dir,'run');await mkdir(run);
 let uploads=0,submissions=0,decisions=0;
 const server=createServer((req,res)=>{
  if(req.url.startsWith('/uncacheable_attributes/presigned_fields')){
   setTimeout(()=>{res.setHeader('Content-Type','application/json');if(mode==='configuration-error'){res.statusCode=503;res.end('{}');}else res.end(JSON.stringify({url:'https://example.org/upload',resume:{fields:{policy:'fixture'},key:'fixture'}}));},600);return;
  }
  if(req.url==='/upload'){uploads++;res.end('accepted');return;}
  if(req.method==='POST'){submissions++;res.end('unexpected submission');return;}
  res.setHeader('Content-Type','text/html');res.end(`<form method="post"><div class="file-upload" aria-labelledby="upload-label-resume"><label id="upload-label-resume">Resume/CV<input id="resume" type="file"></label><div id="result"></div></div><button type="submit">Submit application</button></form><script>
  let manager;
  fetch('/uncacheable_attributes/presigned_fields?fields[]=resume').then(r=>r.json()).then(d=>{if(d.resume)manager={uploadFile:async()=>fetch('/upload')};});
  document.querySelector('#resume').onchange=async e=>{try{await manager.uploadFile(e.target.files[0]);if(${mode==='upload-error'})throw Error('Upload rejected');document.querySelector('#result').innerHTML='<div class="file-upload__filename">original.pdf</div>';e.target.remove();}catch(error){document.querySelector('#result').innerHTML='<p class="helper-text--error">'+error.message+'</p>';}};
  </script>`);
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profilePath=join(dir,'profile.json'),resumePath=join(dir,'original.pdf');await writeFile(profilePath,JSON.stringify({answers:{}}));await writeFile(resumePath,'fixture');
 await writeFile(join(run,'request.json'),JSON.stringify({job:{id:9912094,company:'Fixture Upload',title:'Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath,resumePath,engine:'claude',parkQuestions:true,autoSubmit:false,maxSteps:3}));
 const execImpl=async(_cmd,_args,prompt)=>{decisions++;const c=JSON.parse(prompt).page.frames.flatMap(f=>f.controls).find(c=>c.type==='submit');return{code:0,stdout:JSON.stringify({structured_output:{action:'review',control:c.id,fact:'',message:''}})};};
 try{
  await runWorker(run,{allowLocalFixture:true,stateRoot:join(dir,'state'),execImpl});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(submissions,0);
  if(mode==='delayed'){assert.equal(state.status,'ready_to_submit',state.message);assert.equal(uploads,1);assert.equal(decisions,1);assert.ok(state.events.some(e=>e.message==='Uploaded original resume'));}
  else{assert.equal(state.status,'failed');assert.equal(decisions,0);assert.ok(!state.events.some(e=>e.message==='Uploaded original resume'));assert.match(state.message,mode==='configuration-error'?/configuration did not load/:/upload could not be verified/);}
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});


test('reloading cannot reuse an earlier Greenhouse upload configuration',async()=>{
 let generation=0;
 const server=createServer((req,res)=>{
  if(req.url.startsWith('/uncacheable_attributes/presigned_fields')){res.setHeader('Content-Type','application/json');res.statusCode=generation===1?200:503;res.end(generation===1?JSON.stringify({url:'https://example.org',resume:{fields:{},key:'fixture'}}):'{}');return;}
  generation++;res.setHeader('Content-Type','text/html');res.end('<div class="file-upload" aria-labelledby="upload-label-resume"><input id="resume" type="file"></div><script>fetch("/uncacheable_attributes/presigned_fields").then(r=>r.json())</script>');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch();try{
  const page=await browser.newPage(),prepare=monitorGreenhouseUploads(page);
  await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'load'});
  await prepare(page.mainFrame(),page.locator('#resume'));
  await page.reload({waitUntil:'load'});
  await assert.rejects(prepare(page.mainFrame(),page.locator('#resume')),/configuration did not load/);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});

test('a same-document navigation after the configuration arrives keeps it valid',async()=>{
 const server=createServer((req,res)=>{
  if(req.url.startsWith('/uncacheable_attributes/presigned_fields')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({url:'https://example.org',resume:{fields:{},key:'fixture'}}));return;}
  res.setHeader('Content-Type','text/html');res.end('<div class="file-upload" aria-labelledby="upload-label-resume"><input id="resume" type="file"></div><script>fetch("/uncacheable_attributes/presigned_fields").then(r=>r.json())</script>');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch();try{
  const page=await browser.newPage(),prepare=monitorGreenhouseUploads(page);
  await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'load'});
  await page.waitForTimeout(500);
  await page.evaluate(()=>{history.pushState({},'','#application');location.hash='#app';});
  await prepare(page.mainFrame(),page.locator('#resume'),{timeout:3000});
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});
