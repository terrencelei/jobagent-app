import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {runWorker,atomic} from '../src/dashboard-worker.mjs';

for(const role of ['button','combobox'])test(`approved source fills a ${role} listbox trigger without navigation or submission`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'picker-worker-')),run=join(dir,'run');await mkdir(run);
 let submits=0,reads=0;
 const label='How did you hear about this position?';
 const server=createServer((req,res)=>{if(req.url==='/submit')submits++;res.setHeader('Content-Type','text/html');res.end(`<form action="/submit"><label id="source-label">${label}</label><input type="hidden" name="source"><button type="button" role="${role}" id="source" aria-labelledby="source-label" aria-haspopup="listbox" aria-controls="sources" aria-expanded="false" aria-required="true">No Selection</button><div id="sources" role="listbox" hidden></div><button type="submit">Submit application</button></form><script>
 const source=document.getElementById('source'),menu=document.getElementById('sources');
 source.onclick=()=>{menu.hidden=false;source.setAttribute('aria-expanded','true');menu.innerHTML='';for(const text of ['No Selection','Employee Referral','Job Board','Others']){const option=document.createElement('div');option.role='option';option.textContent=text;option.onclick=()=>{source.textContent=text;document.querySelector('input').value=text;menu.hidden=true;source.setAttribute('aria-expanded','false');};menu.appendChild(option);}};
 </script>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await writeFile(profile,JSON.stringify({answers:{}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:987,company:'Fixture',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,parkQuestions:true,autoSubmit:false,headlessOnly:true,engine:'claude',approvedAnswers:[{question:label,answer:'Job Board'}]});
 const execImpl=async(_c,_a,prompt)=>{reads++;assert.ok(reads<5);const controls=JSON.parse(prompt).page.frames[0].controls,source=controls.find(c=>c.label===label);
  if(reads===1)assert.equal(source.combobox,true);
  const action=source.value!=='Job Board'?{action:'fill',control:source.id,fact:''}:{action:'review',control:controls.find(c=>c.type==='submit').id,fact:''};
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:action,usage:{}})};
 };
 try{await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));assert.equal(state.status,'ready_to_submit',state.message);assert.equal(submits,0);assert.deepEqual(state.questions,[]);assert.ok(state.review.answers.some(a=>a.label===label&&a.value==='Job Board'));}
 finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
