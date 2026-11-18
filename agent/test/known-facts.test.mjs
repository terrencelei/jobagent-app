import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveKnownQuestion,approvedValue,snapshot,pickOption} from '../src/dashboard-worker.mjs';
import {preferenceAnswer} from '../src/applicant-preferences.mjs';
import {followPrompt} from '../src/workday-prompt.mjs';
import {equivalentOption} from '../src/settled-facts.mjs';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
// Mirrors his profile, including noCurrentEmployer (2026-10-23): he has no current employer.
const profile={answers:{noCurrentEmployer:true,firstName:'Alex',email:'test@example.com',school:'Example State University',schoolSearch:'Springfield',degree:"Bachelor's Degree",highestCompletedEducation:"Bachelor's Degree",citizenshipCountries:['United States'],workAuthorizationCountries:['United States'],requiresSponsorship:false,clearanceEligibleYesNo:'Yes',heldSecurityClearance:'No',currentSecurityClearance:'No',veteranStatus:'I am not a protected veteran',eeoRace:'Asian (Not Hispanic or Latino)',gender:'Male',mayContactCurrentEmployer:'Yes',earliestStartDate:'2027-06-16',relocationAssistanceRequired:'Yes',mechanicalCadExperience:'Yes'},workHistory:[{company:'IGEL Technology',to:null}]};
const resolve=(label,options,extra={})=>resolveKnownQuestion({profile,bank:{},job:{location:'Sanford, North Carolina',...extra},question:{label,options,type:options?'select':'text',required:true}});
test('reworded factual questions resolve without a model or applicant approval',()=>{
 for(const [q,options,want] of [
  ['Will you now or in the future require sponsorship for employment visa status?', ['Select One','Yes','No'],'No'],
  ['Are you legally authorized to work in the country where this job is located without requiring employer visa/permit sponsorship for this position?', ['Select One','Yes','No. I need sponsorship'],'Yes'],
  ['Please note that this role is not eligible for work authorization sponsorship. Are you currently authorized to work in the United States without the need for sponsorship?', ['Yes','No'],'Yes'],
  ['Identify Your Current Status',['Select One','U.S. Citizen','H-1B'],'U.S. Citizen'],
  ['Please indicate your current status.',['Select One','US Citizen','US Permanent Resident','Other'],'US Citizen'],
  ['Degree',['Select One',"Bachelor's Level Degree"],"Bachelor's Level Degree"],
  ['Highest level of education/qualification completed.',["Bachelor's Degree Or Equivalent",'Doctorate'],"Bachelor's Degree Or Equivalent"],
  ['Clearance Eligibility*',['Yes','No'],'Yes'],
  ['Active Security Clearance(s)*',['Never held a clearance','Secret'],'Never held a clearance'],
  ['Are you a protected veteran?',['Not a Veteran','Other Veteran'],'Not a Veteran'],
  ['Are you currently employed? If yes, may we speak to your present employer?',['Not currently employed','Currently employed, you may contact my current employer.'],'Not currently employed'],
  ['If relocation assistance is provided, will you require this service?',['Yes','No'],'Yes'],
  ['2. Do you have experience using 3D CAD software (such as NX, SolidWorks, or CATIA)?',['Yes','No'],'Yes'],
 ])assert.equal(resolve(q,options).value,want,q);
 assert.equal(resolve('First Name*').value,'Alex');
});
test('factual resolution does not invent personal history or approve drafts',()=>{
 for(const q of ['What is your country of birth?','Are you related to any current Saronic employees?','When do you plan on ending your internship?','What exceptional work have you done?','Identify Your Current Status'])assert.equal(resolve(q).resolved,false,q);
 assert.equal(resolveKnownQuestion({profile:{answers:{}},question:{label:'Clearance Eligibility',options:['Yes','No']}}).resolved,false);
 assert.equal(resolve('Are you authorized to work in New Zealand?',['Yes','No']).resolved,false);
});
test('checkbox option labels mean selection rather than a new Yes/No question',()=>{
 for(const label of ['Male','Asian (Not Hispanic or Latino)','I am not a protected veteran']){
  assert.equal(resolve(label,['Yes','No']).value,'Yes');
  assert.equal(approvedValue({action:'ask'},{label,type:'radio'},profile,{},new Map()),true);
 }
 assert.equal(approvedValue({action:'fill',fact:'gender'},{label:'Gender',optionLabel:'Female',type:'radio'},profile,{},new Map()),false);
 assert.equal(approvedValue({action:'ask'},{label:'Do you require sponsorship to work in the United States?',optionLabel:'No',type:'radio'},profile,{},new Map()),true);
 assert.equal(approvedValue({action:'ask'},{label:'Do you require sponsorship to work in the United States?',optionLabel:'Yes',type:'radio'},profile,{},new Map()),false);
 for(const [option,want] of [['Top Secret SCI with Polygraph',false],['Secret',false],['Not Applicable',true],['Never held a clearance',true],['Do not wish to disclose',false]])assert.equal(approvedValue({action:'ask'},{label:'Active Security Clearance(s) *',optionLabel:option,type:'checkbox'},profile,{},new Map()),want);
});
test('empty search placeholders are retried until real school choices arrive',async()=>{
 let calls=0,selected=[];
 const driver={options:async()=>++calls<3?['No Items.']:['Example State University'],selected:async()=>selected,click:async x=>{selected=[x]},wait:async()=>{},close:async()=>{}};
 assert.equal(await followPrompt(driver,o=>o.find(x=>x.includes('Example State'))),'Example State University');
});
test('derived answers with one candidate and website source synonyms retain confirmed meaning',()=>{
 assert.equal(equivalentOption('Clearance Eligibility','Yes',['No'],profile.answers,{confirmedAnswer:{key:'clearanceEligibleYesNo',value:'Yes'}}),null);
 assert.equal(equivalentOption('How did you hear about us?','Careers site',['Company Website','Employee Referral'],{hearAbout:'Careers site'}),'Company Website');
});
test('Greenhouse multiple-selection tags count as retained answers',async()=>{
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<!doctype html><div class="select__control"><input id="choice" role="combobox" aria-controls="menu"><div id="selected"></div></div><div id="menu" role="listbox"></div><script>document.querySelector('#choice').oninput=e=>{document.querySelector('#menu').innerHTML='<div role="option">Never held a clearance</div>';document.querySelector('[role=option]').onclick=e=>{document.querySelector('#selected').innerHTML='<span class="select__multi-value__label">Never held a clearance</span>';document.querySelector('#choice').value='';document.querySelector('#menu').innerHTML='';}}</script>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const b=await chromium.launch({headless:true});
 try{const p=await b.newPage();await p.goto(`http://127.0.0.1:${server.address().port}`);assert.equal((await pickOption(p,p.locator('#choice'),'Never held a clearance','Active Security Clearance(s)',profile.answers)).ok,true);assert.equal((await snapshot(p)).frames[0].controls.find(c=>c.domId==='choice').value,'Never held a clearance');}finally{await b.close();await new Promise(r=>server.close(r));}
});
test('native radio groups retain their question and school search uses the confirmed short search',async()=>{
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<!doctype html><fieldset><legend>Do you require sponsorship to work in the United States?</legend><label><input type="radio" name="sponsor">Yes</label><label><input type="radio" name="sponsor">No</label></fieldset><div class="control"><input id="school" role="combobox" aria-controls="menu"><span class="single-value"></span></div><div id="menu" role="listbox"></div><script>document.querySelector('#school').oninput=e=>{document.querySelector('#menu').innerHTML=e.target.value==='Springfield'?'<div role="option">Example State University</div>':'';document.querySelector('[role=option]')?.addEventListener('click',e=>{document.querySelector('.single-value').textContent=e.target.textContent})}</script>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const b=await chromium.launch({headless:true});
 try{const p=await b.newPage();await p.goto(`http://127.0.0.1:${server.address().port}`);const controls=(await snapshot(p)).frames[0].controls.filter(c=>c.type==='radio');assert.equal(controls.length,2);assert.ok(controls.every(c=>c.label.startsWith('Do you require')));assert.deepEqual(controls.map(c=>c.optionLabel),['Yes','No']);
 assert.equal((await pickOption(p,p.locator('#school'),profile.answers.school,'School*',profile.answers)).ok,true);
 }finally{await b.close();await new Promise(r=>server.close(r));}
});

test('Lever checkbox groups take their question from .application-label',async()=>{
 const html=`<!doctype html><meta charset="utf-8"><ul><li class="application-question custom-question"><div class="application-label"><div class="text">How did you learn about this opportunity?<span class="required">✱</span></div></div><div class="application-field"><ul><li><label><input type="checkbox" name="c1" value="a">LinkedIn</label></li><li><label><input type="checkbox" name="c1" value="b">FieldAI Website</label></li></ul></div></li><li class="application-question"><div class="application-label">Describe an achievement</div><textarea placeholder="Type your response"></textarea></li></ul>`;
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const b=await chromium.launch({headless:true});
 try{const p=await b.newPage();await p.goto(`http://127.0.0.1:${server.address().port}`);const controls=(await snapshot(p)).frames[0].controls.filter(c=>c.type==='checkbox');
  assert.equal(controls.length,2);assert.ok(controls.every(c=>c.label==='How did you learn about this opportunity?'),JSON.stringify(controls.map(c=>c.label)));assert.deepEqual(controls.map(c=>c.optionLabel),['LinkedIn','FieldAI Website']);
  assert.ok(controls.every(c=>c.required));
  assert.equal((await snapshot(p)).frames[0].controls.find(c=>c.type==='textarea').label,'Describe an achievement');
 }finally{await b.close();await new Promise(r=>server.close(r));}
});

test('Boeing "Are you a veteran?" needs his explicit not-a-veteran answer, not just not-protected',()=>{
 const options=['Select One','I AM NOT A VETERAN','I IDENTIFY AS A VETERAN, JUST NOT A PROTECTED VETERAN','I DO NOT WISH TO SELF-IDENTIFY'];
 const ask=p=>resolveKnownQuestion({profile:p,bank:{},job:{},question:{label:'Are you a veteran?',options,type:'select',required:true}});
 assert.equal(ask({answers:{veteranStatus:'I am not a protected veteran',selfIdVeteran:'No, I am not a veteran or active member'}}).value,'I AM NOT A VETERAN');
 assert.equal(ask({answers:{veteranStatus:'I am not a protected veteran'}}).resolved,false);
});
