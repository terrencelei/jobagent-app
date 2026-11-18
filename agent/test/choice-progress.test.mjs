import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {runWorker,atomic,approvedValue,choiceNeedsAction} from '../src/dashboard-worker.mjs';

const relocation={label:'What office(s) would you be willing to relocate to? (Select all that apply)',type:'checkbox',optionLabel:'San Diego, California',choiceLabels:['San Diego, California','Dallas, Texas'],value:'false'};
test('willingness to relocate does not deselect every office or invent a preferred office',()=>{
 const profile={answers:{willingToRelocate:'Yes'}};
 assert.throws(()=>approvedValue({},relocation,profile,{},new Map()),/confirmed offered answer/);
 assert.equal(choiceNeedsAction(relocation,profile,{},new Map()),true);
 const bank={[relocation.label.toLowerCase()]:{answer:'San Diego, California'}};
 assert.equal(approvedValue({},relocation,profile,bank,new Map()),true);
 assert.equal(approvedValue({},{...relocation,optionLabel:'Dallas, Texas'},profile,bank,new Map()),false);
});

test('local Lever-style native groups reach review without repeatedly unchecking alternatives',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'choice-progress-')),run=join(dir,'run');await mkdir(run);
 let posts=0;
 const server=createServer((req,res)=>{if(req.method==='POST')posts++;res.setHeader('Content-Type','text/html');res.end(`<form method="post"><ul><li class="application-question"><div class="application-label">Will you require sponsorship for employment now or in the future?<span class="required">*</span></div><label><input type="radio" name="sponsor" value="Yes">Yes</label><label><input type="radio" name="sponsor" value="No">No</label></li><li class="application-question"><div class="application-label">${relocation.label}</div><label><input type="checkbox" name="office">San Diego, California</label><label><input type="checkbox" name="office">Dallas, Texas</label></li></ul><button type="submit">Submit Application</button></form>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const profilePath=join(dir,'profile.json'),resumePath=join(dir,'resume.pdf');
  await writeFile(profilePath,JSON.stringify({answers:{requiresSponsorship:false,willingToRelocate:'Yes'}}));await writeFile(resumePath,'fixture');
  await atomic(join(run,'request.json'),{job:{id:321,company:'Fixture',title:'Engineer',location:'San Diego, California',url:`http://127.0.0.1:${server.address().port}/apply`},profilePath,resumePath,engine:'claude',parkQuestions:true,maxSteps:4});
  let calls=0;
  await runWorker(run,{stateRoot:join(dir,'state'),allowLocalFixture:true,execImpl:async(_command,_args,prompt)=>{
   calls++;const fields=JSON.parse(prompt).page.frames.flatMap(f=>f.controls),choice=fields.find(c=>['radio','checkbox'].includes(c.type));
   const control=choice??fields.find(c=>c.type==='submit');
   return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:choice?'fill':'review',control:control.id,fact:'requiresSponsorship',message:''},usage:{}})};
  }});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,'ready_to_submit',JSON.stringify({message:state.message,events:state.events}));assert.equal(calls,3);assert.equal(posts,0);
  assert.equal(state.review.answers.find(a=>a.label.startsWith('Will you require')).value,'true');
  assert.ok(state.events.some(e=>e.message.startsWith('Left optional unanswered')));
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
