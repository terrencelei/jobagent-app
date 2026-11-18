import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {snapshot} from '../src/dashboard-worker.mjs';
import {safeHistoryAdd} from '../src/history-controls.mjs';
import {runWorker} from '../src/dashboard-worker.mjs';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';

const url='http://localhost/apply?job=fixture';
test('SAP generic Add requires recognized history scope and preserves inert-link and submission guards',()=>{
 const c={label:'\uE1F6 Add',type:'button',inForm:true,historySection:'workHistory'};
 assert.equal(safeHistoryAdd(c,url),true);
 assert.equal(safeHistoryAdd({...c,historySection:'education'},url),true);
 assert.equal(safeHistoryAdd({...c,type:'a',href:'javascript:void(0);'},url),true);
 for(const patch of [{historySection:undefined},{historySection:'references'},{inForm:false},{type:'submit'},{label:'Add and submit'},{href:'/submit'},{href:'https://evil.example/apply'},{href:'javascript:submitApplication()'},{href:'#review'},{href:'#',target:'_blank'},{href:'#',download:true}])assert.equal(safeHistoryAdd({...c,...patch},url),false,JSON.stringify(patch));
});

test('worker adds SAP employment and education and fills confirmed exact dates before Review without submitting',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sap-history-')),run=join(dir,'run');await mkdir(run);
 let posts=0,decisions=0;
 const server=createServer((req,res)=>{
  if(req.method==='POST')posts++;
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end(`<form method="post"><h2>Personal information</h2><label>Available Start Date<input id="available" type="date" required></label><h2>Previous Employment</h2><button id="add-work" type="button" onclick="this.insertAdjacentHTML('beforebegin','<label>Title<input id=title required></label><label>From Date<input id=from type=date required></label><label>End Date<input id=to type=date required></label>');this.disabled=true">&#xE1F6; Add</button><h2>Formal Education</h2><button id="add-school" type="button" onclick="this.insertAdjacentHTML('beforebegin','<label>School<input id=school required></label><label>From Date<input id=school-from type=date required></label><label>End Date<input id=school-to type=date required></label>');this.disabled=true">Add</button><button type="submit">Submit application</button></form>`);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profilePath=join(dir,'profile.json'),resumePath=join(dir,'resume.pdf');
 await writeFile(profilePath,JSON.stringify({answers:{earliestStartDate:'2027-06-16'},workHistory:[{title:'Fixture Engineer',from:'2025-01-15',to:'2025-04-30'}],education:[{school:'Fixture University',from:'2024-08-01',to:'2027-06-01'}]}));
 await writeFile(resumePath,'fixture');
 await writeFile(join(run,'request.json'),JSON.stringify({job:{id:998610,company:'SAP Fixture',title:'Engineer',url:`http://127.0.0.1:${server.address().port}`},profilePath,resumePath,engine:'claude',parkQuestions:true,autoSubmit:false,maxSteps:12}));
 const plan=[['add-work'],['title','workHistory.0.title'],['from','workHistory.0.from'],['to','workHistory.0.to'],['add-school'],['school','education.0.school'],['school-from','education.0.from'],['school-to','education.0.to'],['available','earliestStartDate']];
 const execImpl=async(_cmd,_args,prompt)=>{
  const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls),next=plan[decisions++];
  const control=next?controls.find(c=>c.domId===next[0]):controls.find(c=>c.type==='submit');
  assert.ok(control,'expected fresh control '+next?.[0]);
  const action=next?{action:next[1]?'fill':'click',fact:next[1]||''}:{action:'review',fact:''};
  return{code:0,stderr:'',stdout:JSON.stringify({structured_output:{...action,control:control.id,message:''},usage:{}})};
 };
 try{
  await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')});
  const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.equal(state.status,'ready_to_submit',state.message);
  assert.equal(decisions,10);assert.equal(posts,0);
  assert.equal(Boolean(state.submission_attempted),false);
  for(const date of ['2025-01-15','2025-04-30','2024-08-01','2027-06-01','2027-06-16'])assert.ok(JSON.stringify(state.review).includes(date));
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('Chromium refresh distinguishes SAP work/education Add and newly inserted date fields from contact Add',async()=>{
 const browser=await chromium.launch({headless:true});
 let posts=0;
 try{
  const page=await browser.newPage();
  await page.route('http://localhost/**',route=>{if(route.request().method()==='POST')posts++;return route.fulfill({contentType:'text/html; charset=utf-8',body:'<html></html>'});});
  await page.goto(url);
  await page.setContent(`<form method="post"><h2>Personal information</h2><label>Available Start Date<input type="date" required></label><button type="button" id="contact">Add</button><button type="button" aria-expanded="true" aria-controls="work">Previous Employment</button><section id="work"><label>Company Name<input></label><button type="button" id="work-add" onclick="this.insertAdjacentHTML('beforebegin','<label>From Date<input type=date required></label><label>End Date<input type=date required></label>')">&#xE1F6; Add</button></section><h2>Formal Education</h2><label>School<input></label><a role="button" href="javascript:void(0);" id="school-add">Add</a><h2>References</h2><button type="button" id="reference-add">Add</button><button type="submit">Submit application</button></form>`);
  let controls=(await snapshot(page)).frames[0].controls;
  const get=id=>controls.find(c=>c.domId===id);
  assert.equal(get('work-add').historySection,'workHistory');
  assert.equal(get('school-add').historySection,'education');
  for(const id of ['work-add','school-add'])assert.equal(safeHistoryAdd(get(id),url),true);
  for(const id of ['contact','reference-add'])assert.equal(safeHistoryAdd(get(id),url),false);
  assert.equal(controls.find(c=>c.label==='Available Start Date').required,true);
  await page.locator('#work-add').click();
  controls=(await snapshot(page)).frames[0].controls;
  const dates=controls.filter(c=>c.type==='date');
  assert.equal(dates.length,3);
  assert.deepEqual(dates.map(c=>c.historySection),[undefined,'workHistory','workHistory']);
  assert.ok(dates.every(c=>c.required));
  assert.equal(posts,0);
 }finally{await browser.close();}
});

test('Phenom type=submit Add experience/education is a history add, not a final submit (Cisco 12281)',()=>{
 const c={label:'Add experience',type:'submit',inForm:true,historySection:'workHistory',domId:'array-button-add-experienceData'};
 assert.equal(safeHistoryAdd(c,url),true);
 assert.equal(safeHistoryAdd({...c,label:'Add education',historySection:'education',domId:'array-button-add-educationData'},url),true);
 // "My experience" is not a recognised section heading, so the id and label suffice without historySection.
 assert.equal(safeHistoryAdd({...c,historySection:undefined},url),true);
 for(const patch of [{domId:'next'},{domId:undefined},{label:'Submit'},{label:'Add education'},{inForm:false},{href:'/submit'}])assert.equal(safeHistoryAdd({...c,...patch},url),false,JSON.stringify(patch));
});
