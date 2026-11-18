import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {textDateInputValue} from '../src/text-date-input.mjs';
import {runWorker} from '../src/dashboard-worker.mjs';

test('only exact dates in text pickers declaring US calendar format are adapted',async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage();await page.setContent('<input id="date"><input id="plain"><script>window.jQuery=el=>({data:()=>el.id==="date"?{format:()=>"MM/DD/YYYY"}:undefined});</script>');
  assert.equal(await textDateInputValue(page.locator('#date'),'text','2028-02-29'),'02/29/2028');
  assert.equal(await page.locator('#date').evaluate(el=>el===document.activeElement),true);
  for(const value of ['2027-02-29','2027-06','June 2027','2027-13-01'])assert.equal(await textDateInputValue(page.locator('#date'),'text',value),value);
  assert.equal(await textDateInputValue(page.locator('#plain'),'text','2027-06-16'),'2027-06-16');
  assert.equal(await textDateInputValue(page.locator('#date'),'date','2027-06-16'),'2027-06-16');
  await page.evaluate(()=>window.jQuery=()=>({data:()=>({format:()=> 'DD/MM/YYYY'})}));
  assert.equal(await textDateInputValue(page.locator('#date'),'text','2027-06-16'),'2027-06-16');
 }finally{await browser.close();}
});

test('worker retains approved start date through text picker parsing and reaches Review without another approval',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'text-date-worker-'));let posts=0,calls=0;
 const server=createServer((req,res)=>{
  if(req.method==='POST')posts++;
  res.setHeader('Content-Type','text/html');res.end(`<form method="post"><label for="date">What is your earliest start date?</label><input id="date" required type="text" value=""><button type="submit">Submit application</button></form><script>
  window.jQuery=()=>({data:()=>({format:()=> 'MM/DD/YYYY'})});
  document.querySelector('input').addEventListener('focus',e=>{if(!e.target.value)e.target.value='10/16/2026';});
  document.querySelector('input').addEventListener('input',e=>{if(!/^\\d{2}\\/\\d{2}\\/\\d{4}$/.test(e.target.value))e.target.value='10/16/2026';});
  </script>`);
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const run=join(dir,'run');await mkdir(run);await writeFile(join(dir,'resume.pdf'),'fixture');await writeFile(join(dir,'profile.json'),JSON.stringify({answers:{earliestStartDate:'2027-06-16'}}));
  await writeFile(join(run,'request.json'),JSON.stringify({job:{id:695000,company:'Fixture',title:'Engineer',role_type:'FULL_TIME',url:`http://127.0.0.1:${server.address().port}`},profilePath:join(dir,'profile.json'),resumePath:join(dir,'resume.pdf'),engine:'claude',parkQuestions:true,maxSteps:4,approvedAnswers:[{question:'What is your earliest start date?',answer:'2027-06-16'}]}));
  await runWorker(run,{allowLocalFixture:true,stateRoot:join(dir,'state'),execImpl:async(_c,_a,input)=>{
   calls++;const controls=JSON.parse(input).page.frames.flatMap(f=>f.controls),date=controls.find(c=>c.label==='What is your earliest start date?'),submit=controls.find(c=>c.type==='submit');
   const action=date&&date.value!=='06/16/2027'?{action:'fill',control:date.id,fact:'earliestStartDate',message:''}:{action:'review',control:submit.id,fact:'',message:''};
   return{code:0,stderr:'',stdout:JSON.stringify({structured_output:action,usage:{}})};
  }});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));assert.equal(state.status,'ready_to_submit',state.message);assert.equal(state.questions.length,0);assert.ok(state.review.answers.some(a=>a.value==='06/16/2027'));assert.equal(calls,2);assert.equal(posts,0);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
