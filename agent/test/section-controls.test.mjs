import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {runWorker} from '../src/dashboard-worker.mjs';
import {safeSectionExpand} from '../src/section-controls.mjs';

const url='https://example.org/apply?job=123';
test('section expansion accepts explicit reveal controls without permitting navigation or submission',()=>{
 const c={type:'button',label:'Expand all sections'};
 assert.equal(safeSectionExpand(c,url),true);
 for(const href of ['#','javascript:void(0);','javascript:;'])assert.equal(safeSectionExpand({...c,type:'a',href},url),true);
 assert.equal(safeSectionExpand({...c,label:'Personal information',ariaExpanded:'false',controlsSection:true},url),true);
 for(const patch of [{type:'submit'},{type:'reset'},{type:'checkbox'},{label:'Collapse all sections'},{href:'https://evil.example/'},{href:'/submit#'},{href:'#review'},{href:'javascript:submitApplication()'},{target:'_blank'},{download:true},{label:'Expand all sections and apply'},{label:'Personal information',ariaExpanded:'true',controlsSection:true},{label:'Personal information',ariaExpanded:'false',controlsSection:false}])assert.equal(safeSectionExpand({...c,...patch},url),false,JSON.stringify(patch));
});

test('worker expands linked sections and a collapsed panel, validates newly visible fields and reaches Review without POST',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'section-worker-')),run=join(dir,'run'),stateRoot=join(dir,'state');
 await mkdir(run);await mkdir(stateRoot);let posts=0,decisions=0;
 const server=createServer((req,res)=>{if(req.method==='POST')posts++;res.setHeader('Content-Type','text/html');res.end(`<form method="post"><a role="button" href="javascript:void(0);" onclick="document.querySelector('#personal').hidden=false">Expand all sections</a><section id="personal" hidden><label>First name<input required></label><button type="button" aria-expanded="false" aria-controls="details" onclick="document.querySelector('#details').hidden=false;this.setAttribute('aria-expanded','true')">Additional information</button><section id="details" hidden><label>Last name<input required></label></section></section><button type="submit">Submit application</button></form>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profilePath=join(dir,'profile.json'),resumePath=join(dir,'resume.pdf');
 await writeFile(profilePath,JSON.stringify({answers:{firstName:'Fixture',lastName:'Applicant'}}));await writeFile(resumePath,'fixture');
 await writeFile(join(run,'request.json'),JSON.stringify({job:{id:999994,company:'Fixture Sections',title:'Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath,resumePath,engine:'claude',parkQuestions:true,autoSubmit:false,maxSteps:6}));
 const execImpl=async(_cmd,_args,prompt)=>{
  const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);let action;
  switch(decisions++){
   case 0:assert.ok(!controls.some(c=>c.label==='First name'));action={action:'click',control:controls.find(c=>c.label==='Expand all sections').id};break;
   case 1:assert.ok(controls.some(c=>c.label==='First name'));action={action:'fill',control:controls.find(c=>c.label==='First name').id,fact:'firstName'};break;
   case 2:{const c=controls.find(c=>c.label==='Additional information');assert.equal(c.ariaExpanded,'false');assert.equal(c.controlsSection,true);action={action:'click',control:c.id};break;}
   case 3:action={action:'fill',control:controls.find(c=>c.label==='Last name').id,fact:'lastName'};break;
   default:action={action:'review',control:controls.find(c=>c.type==='submit').id};
  }
  return{code:0,stderr:'',stdout:JSON.stringify({structured_output:{fact:'',message:'',...action},usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,stateRoot,allowLocalFixture:true});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,'ready_to_submit',state.message);assert.equal(posts,0);assert.equal(decisions,5);
  assert.match(JSON.stringify(state.review),/Fixture/);assert.match(JSON.stringify(state.review),/Applicant/);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
