import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {routineApplicationAnswer} from '../src/routine-application-policy.mjs';
import {chromium} from 'playwright';
import {pickOption} from '../src/dashboard-worker.mjs';
import {runWorker} from '../src/dashboard-worker.mjs';
const company='Fixture';
const label='Have you worked at Fixture?*';
const offered='I have not worked at Fixture';
const options=['I am a previous employee','I am a current contractor',offered];
const answers={employerEmploymentDefault:'No'};
test('negative employer history uses the unique employer-bound offered wording',()=>{
 assert.equal(routineApplicationAnswer(label,answers,{company,options}).value,offered);
 assert.equal(routineApplicationAnswer(label,answers,{company,options:[...options,offered]}).value,'No');
 assert.equal(routineApplicationAnswer(label,answers,{company,options:['I have not worked at Other']}).value,'No');
 assert.equal(routineApplicationAnswer(label,{...answers,confirmedEmploymentCompanies:[{company}]},{company,options}).value,'Yes');
 assert.equal(routineApplicationAnswer('Have you or your family worked at Fixture?',answers,{company,options}).value,'No');
});
test('worker retains approved descriptive employment choice and reaches review without a POST',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'employer-history-'));const run=join(dir,'run'),stateRoot=join(dir,'state');await mkdir(run);await mkdir(stateRoot);
 let posts=0,decisions=0;
 const server=createServer((req,res)=>{if(req.method==='POST')posts++;res.setHeader('Content-Type','text/html');res.end(`<form method="post"><label for="history">${label}</label><select id="history" required><option value="">Select...</option>${options.map((o,i)=>`<option value="${i+1}">${o}</option>`).join('')}</select><button type="submit">Submit application</button></form>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 const profilePath=join(dir,'profile.json'),resumePath=join(dir,'resume.pdf');await writeFile(profilePath,JSON.stringify({answers}));await writeFile(resumePath,'fixture');
 await writeFile(join(run,'request.json'),JSON.stringify({job:{id:999999,company,title:'Engineer',url},profilePath,resumePath,engine:'claude',parkQuestions:true,autoSubmit:false,approvedAnswers:[{question:label,answer:offered}]}));
 const execImpl=async(_c,_a,prompt)=>{const cs=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);const first=decisions++===0;const c=cs.find(c=>first?c.type==='select-one':c.type==='submit');return{code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:first?'fill':'review',control:c.id,fact:'',message:''},usage:{}})};};
 try{await runWorker(run,{execImpl,stateRoot,allowLocalFixture:true});const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));assert.equal(state.status,'ready_to_submit',state.message);assert.match(JSON.stringify(state.review),/I have not worked at Fixture/);assert.equal(posts,0);assert.equal(decisions,2);}finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('dynamic browser dropdown maps the initial No fact after reading its offered labels',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<label for="history">${label}</label><div class="select__control"><span class="select__single-value"></span><input id="history" role="combobox" aria-controls="choices" aria-expanded="true"></div><div id="choices" role="listbox">${options.map(o=>`<div role="option">${o}</div>`).join('')}</div><script>document.querySelectorAll('[role=option]').forEach(o=>o.onclick=()=>{document.querySelector('.select__single-value').innerText=o.innerText;document.querySelector('#choices').hidden=true;});</script>`);
  const picked=await pickOption(page.mainFrame(),page.locator('#history'),'No',label,answers,{company});
  assert.equal(picked.ok,true);assert.equal(picked.value,offered);
  assert.equal(await page.locator('.select__single-value').innerText(),offered);
 }finally{await browser.close();}
});
