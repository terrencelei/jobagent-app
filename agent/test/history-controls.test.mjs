import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {approvedValue,snapshot,runWorker,safeNavigation,isFinalControl} from '../src/dashboard-worker.mjs';
import {safeHistoryAdd} from '../src/history-controls.mjs';
import {regionalLocationCorrection} from '../src/regional-controls.mjs';

const profile={answers:{city:'Home Town',applicationLocationRule:{defaultRegion:'bayArea',bayArea:{city:'Home Town'}}},workHistory:[{company:'Fixture Research',location:'Research City'},{company:'Fixture Manufacturing',location:'Factory City'}]};
const history={type:'text',inForm:true,label:'Location',historySection:'workHistory',value:'Home Town'};
test('explicit indexed history locations win over generic city, banks and regional preferences',()=>{
 assert.equal(approvedValue({fact:'workHistory.0.location'},history,profile,{},new Map(),'Fixture'),'Research City');
 assert.equal(approvedValue({fact:'workHistory.1.location'},history,profile,{location:{answer:'Home Town'}},new Map([['location','Home Town']]),'Fixture'),'Factory City');
 for(const fact of ['city','education.0.location','workHistory.9.location','workHistory.0.company'])assert.throws(()=>approvedValue({fact},history,profile,{},new Map(),'Fixture'),/matching confirmed history fact/);
 assert.equal(regionalLocationCorrection({frames:[{controls:[history]}]},profile,{}),null);
 assert.match(approvedValue({fact:'city'},{...history,historySection:undefined},profile,{},new Map(),'Fixture'),/^Home Town/);
});
test('add-entry permission excludes submits, external links, unrelated buttons and standalone controls',()=>{
 const control={label:'add another entry to Work Experience',type:'button',inForm:true};
 assert.equal(safeHistoryAdd(control),true);
 assert.equal(safeNavigation(control.label),false);
 assert.equal(isFinalControl(control),false);
 for(const patch of [{type:'submit'},{href:'https://example.org/'},{inForm:false},{label:'Delete Work Experience'},{label:'Add account'},{label:'Add Work Experience and Submit'}])assert.equal(safeHistoryAdd({...control,...patch}),false);
});
test('same-document history anchors accept fragments and inert targets only',()=>{
 const c={label:'add another entry to Work Experience',type:'button',inForm:true};
 const url='https://example.org/apply?job=123';
 for(const href of ['#','https://example.org/apply?job=123#','javascript:void(0);','javascript:;'])assert.equal(safeHistoryAdd({...c,href},url),true,href);
 for(const href of ['https://example.org/submit','https://example.org/apply?job=123#/review','https://example.org/apply?job=123#history','https://example.org/apply?job=999#history','https://other.example/apply?job=123#history','javascript:submitApplication()','data:text/html,submit'])assert.equal(safeHistoryAdd({...c,href},url),false,href);
 assert.equal(safeHistoryAdd({...c,type:'submit',href:'#'},url),false);
 for(const extra of [{target:'_blank'},{download:true}])assert.equal(safeHistoryAdd({...c,href:'#',...extra},url),false);
});
test('snapshot distinguishes personal, work and education sections in Chromium',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.route('http://localhost/**',route=>route.fulfill({body:'<html></html>',contentType:'text/html'}));
  await page.goto('http://localhost/');
  await page.setContent('<form><div><h2>Personal information</h2><label>Location<input></label><div class="FormHeader">Work experience</div><label>Location<input></label><fieldset><legend>Home address</legend><label>Location<input></label></fieldset><h2>Education</h2><label>Location<input></label><h2>Contact information</h2><label>Location<input></label></div></form>');
  const controls=(await snapshot(page)).frames[0].controls;
  assert.deepEqual(controls.map(c=>c.historySection),[undefined,'workHistory',undefined,'education',undefined]);
 }finally{await browser.close();}
});
test('unheaded local history rows, labelled datasets and wizard wrappers keep contact fields separate',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.route('http://localhost/**',r=>r.fulfill({body:'<html></html>',contentType:'text/html'}));await page.goto('http://localhost/');
  await page.setContent('<form><div aria-label="Step 2 of 4"><div><label>Email<input></label><label>Location<input id="home"></label></div><div><label>Company<input></label><label>Location<input id="work"></label></div><div class="MultipleDatasetEntryFormField"><div class="tc_formLabel"><label>Work Experience *</label><span>If this does not apply, leave blank</span></div><label>Location<input id="dataset"></label></div><span id="school-title">Education</span><div aria-labelledby="school-title"><label>Location<input id="school"></label></div></div></form>');
  const controls=(await snapshot(page)).frames[0].controls;
  const byId=id=>controls.find(c=>c.domId===id)?.historySection;
  assert.equal(byId('home'),undefined);assert.equal(byId('work'),'workHistory');assert.equal(byId('dataset'),'workHistory');assert.equal(byId('school'),'education');
 }finally{await browser.close();}
});
test('worker corrects history locations and adds missing employment before Review with zero submissions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'history-worker-')),run=join(dir,'run'),stateRoot=join(dir,'state');
 await mkdir(run);await mkdir(stateRoot);
 let posts=0,decisions=0;
 const server=createServer((req,res)=>{if(req.method==='POST')posts++;res.setHeader('Content-Type','text/html');res.end(`<form method="post"><h2>Personal information</h2><label>Location<input value="Home Town, California, United States" required></label><div class="MultipleDatasetEntryFormField"><div class="tc_formLabel"><label>Work Experience *</label></div><div class="tc_formField"><div class="schema_field_MultipleDatasetEntryInput"><label>Company<input value="Fixture Research"></label><label>Location<input value="Home Town" required></label></div><a role="button" href="javascript:void(0);" id="add-history">add another entry to Work Experience</a></div></div><button type="submit">Submit application</button></form><script>document.querySelector('#add-history').addEventListener('click', function(){this.insertAdjacentHTML('beforebegin','<div class="schema_field_MultipleDatasetEntryInput"><label>Company<input required></label><label>Location<input required></label></div>');this.disabled=true;});</script>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profilePath=join(dir,'profile.json'),resumePath=join(dir,'resume.pdf');
 await writeFile(profilePath,JSON.stringify(profile));await writeFile(resumePath,'fixture');
 await writeFile(join(run,'request.json'),JSON.stringify({job:{id:999997,company:'Fixture',title:'Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath,resumePath,engine:'claude',parkQuestions:true,autoSubmit:false,maxSteps:8}));
 const execImpl=async(_cmd,_args,prompt)=>{
  const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);let action;
  assert.ok(controls.some(c=>c.historySection),JSON.stringify(controls));
  switch(decisions++){
   case 0:action={action:'fill',control:controls.find(c=>c.historySection&&c.label==='Location').id,fact:'workHistory.0.location'};break;
   case 1:action={action:'click',control:controls.find(c=>c.label.startsWith('add another')).id};break;
   case 2:action={action:'fill',control:controls.filter(c=>c.label==='Company').at(-1).id,fact:'workHistory.1.company'};break;
   case 3:action={action:'fill',control:controls.filter(c=>c.historySection&&c.label==='Location').at(-1).id,fact:'workHistory.1.location'};break;
   default:action={action:'review',control:controls.find(c=>c.type==='submit').id};
  }
  return{code:0,stderr:'',stdout:JSON.stringify({structured_output:{fact:'',message:'',...action},usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,stateRoot,allowLocalFixture:true});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,'ready_to_submit',state.message);assert.equal(posts,0);assert.equal(decisions,5);
  const review=JSON.stringify(state.review);assert.match(review,/Research City/);assert.match(review,/Factory City/);assert.match(review,/Fixture Manufacturing/);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
