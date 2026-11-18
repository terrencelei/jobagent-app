import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readWorkdayFields,selectWorkdayListbox,readWorkdayListboxOptions,fillWorkdaySignedDate} from '../src/workday-controls.mjs';
import {resolveQuestion,pickOption,reviewProblems,isAcknowledgement} from '../src/workday.mjs';
import {resolveUnknownQuestion,setCheckedControl} from '../src/dashboard-worker.mjs';
import {profileFact} from '../src/profile-facts.mjs';
const answers={dateOfBirth:'2004-07-15',requiresSponsorship:false,citizenshipCountries:['United States'],workAuthorizationCountries:['United States'],recruitmentEmailConsent:'Yes',recruitmentMessageConsent:'Yes'};
const ctx={answers,company:'Fixture',location:'Berkeley, CA',history:[{company:'Independent Labs'}]};
const sponsorship='Will you now or in the future require sponsorship for an employment visa or immigration related benefit? For purposes of this question, “employment visa or immigration related benefit” includes (but is not limited to) H-1B petitions, sponsorship for OPT extension purposes, TN applications, E-3 visas, and I-140 or Adjustment of Status portability. Please ask us if you are uncertain whether you may need immigration sponsorship or require clarification.';
test('actual NXP and CoStar blockers resolve from the confirmed profile',async()=>{
 assert.equal(resolveQuestion('Are you over 18 years of age?',{},ctx).candidates[0],'Yes');
 assert.equal(resolveQuestion('Have you worked with us before?',{},ctx).candidates[0],'No');
 assert.equal(resolveQuestion('Employee ID (if applicable)',{},ctx),null);
 assert.equal(resolveQuestion('Have you ever been issued a Fixture Employee ID?',{},ctx).candidates[0],'No');
 assert.equal(pickOption(['I identify as a veteran, just not a protected veteran.','I am not a veteran.'],resolveQuestion('Please indicate if you are veteran.',{},ctx).candidates),'I am not a veteran.');
 assert.equal(resolveQuestion('Do you accept that we use your information for other job openings?',{},ctx).candidates[0],'Yes');
 assert.equal(resolveQuestion(sponsorship,{},ctx).candidates[0],'No');
 const result=await resolveUnknownQuestion({question:{label:sponsorship,options:['Select One','Yes','No']},profile:{answers},bank:{},job:ctx,execImpl:()=>{throw Error('Model call not necessary');}});
 assert.equal(result.value,'No');
 assert.equal(resolveQuestion(sponsorship,{}, {...ctx,location:'London, United Kingdom'}),null);
 assert.equal(resolveQuestion('Are you over 18 years of age?',{}, {answers:{}}),null);
 assert.equal(resolveQuestion('Are you at least 18 years of age?',{}, {...ctx,now:'2022-07-14T00:00:00Z'}).candidates[0],'No');
 assert.equal(resolveQuestion('Are you at least 18 years of age?',{}, {...ctx,now:'2022-07-15T00:00:00Z'}).candidates[0],'Yes');
 // Piper 13343 (iRecruit): redundant 'at least ... or older', with a non-breaking space before the asterisk.
 assert.equal(resolveQuestion('Are you at least 18 years of age or older?\u00a0*',{}, {...ctx,now:'2022-07-15T00:00:00Z'}).candidates[0],'Yes');
 assert.equal(resolveQuestion('Are you at least 18 years of age or older?\u00a0*',{}, {...ctx,now:'2022-07-14T00:00:00Z'}).candidates[0],'No');
 // Piper 13343: years completed on the in-progress degree row, from the saved start and graduation dates.
 {const answers={eduStartMonth:'August',eduStartYear:'2023',graduationDate:'06/15/2027'};
  assert.equal(profileFact('Years Completed (numeric field):\u00a0*',answers,{now:'2026-10-25T00:00:00Z'}).value,'3');
  assert.equal(profileFact('Years Completed (numeric field):\u00a0*',answers,{now:'2026-06-01T00:00:00Z'}).value,'2');
  assert.equal(profileFact('Years Completed (numeric field):\u00a0*',answers,{now:'2027-08-01T00:00:00Z'}),null);}
 assert.equal(resolveQuestion('Are you over 18 and willing to work overnight shifts?',{},ctx),null);
 assert.equal(resolveQuestion('What is your highest level of completed education?',{}, {...ctx,answers:{degree:"Bachelor's Degree",graduationDate:'06/15/2027'}}),null);
 assert.equal(pickOption(['Yes','No','Not Applicable'],resolveQuestion('Do you possess a valid work permit in the country for which the position resides?',{},ctx).candidates),'Not Applicable');
 assert.equal(resolveQuestion('Do you possess a valid work permit in the country for which the position resides?',{}, {...ctx,approvedAnswers:[{question:'Do you possess a valid work permit in the country for which the position resides?',answer:'Yes'}]}).candidates[0],'Yes');
 assert.equal(resolveQuestion('Do you possess a valid work permit in the country for which the position resides?',{}, {...ctx,location:'London, United Kingdom'}),null);
 assert.deepEqual(reviewProblems('SMS Opt-in\nYes',{recruitmentSmsConsent:'Yes'}),[]);
});
test('Workday closes an unlabelled previous menu before activating an overlapping control',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<button aria-haspopup="listbox" value="old-no" onclick="document.querySelector('#old-menu').hidden=true">No</button>
  <div data-automation-id="formField-next"><button id="next" aria-haspopup="listbox" onclick="document.querySelector('#next-menu').hidden=false">Select One</button></div>
  <ul id="old-menu" role="listbox" aria-activedescendant="old-no" style="position:absolute;inset:0;background:white"><li role="option">No</li></ul>
  <ul id="next-menu" role="listbox" hidden><li role="option" onclick="document.querySelector('#next').innerText=this.innerText;this.parentElement.hidden=true">Yes</li></ul>`);
  const result=await selectWorkdayListbox(page,page.locator('#next'),['Yes']);
  assert.equal(result.value,'Yes');assert.equal(await page.locator('#old-menu').isVisible(),false);
 }finally{await browser.close();}
});
test('disability checkbox choices retain their question context and the confirmed negative choice',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<div data-automation-id="formField-disabilityStatus"><legend>Please check one of the boxes below:*</legend><fieldset data-automation-id="disabilityStatus-CheckboxGroup" aria-required="true">
  <input id="yes" type="checkbox"><label for="yes">Yes, I have a disability, or have had one in the past</label>
  <input id="no" type="checkbox"><label for="no">No, I do not have a disability and have not had one in the past</label>
  <input id="decline" type="checkbox"><label for="decline">I do not want to answer</label></fieldset></div>`);
  const [field]=await readWorkdayFields(page);
  assert.equal(field.kind,'choice-checkbox');
  const want=pickOption(field.options,resolveQuestion(field.label,{},ctx).candidates);
  assert.equal(want,'No, I do not have a disability and have not had one in the past');
  for(const [i,id]of field.optionIds.entries())await setCheckedControl(page,page.locator(`[id="${id}"]`),i===field.options.indexOf(want));
  assert.equal(await page.locator('#yes').isChecked(),false);assert.equal(await page.locator('#no').isChecked(),true);
  assert.equal((await readWorkdayFields(page))[0].value,want);
 }finally{await browser.close();}
});
test('signature date fills all segments without changing birth dates and verifies retention',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<div data-automation-id="formField-dateSignedOn">${['Month','Day','Year'].map(part=>`<div data-automation-id="dateSection${part}-display" onclick="window.activePart='${part}'">${part}</div><input data-part="${part}" data-automation-id="dateSection${part}-input" oninput="if(window.activePart!==this.dataset.part)this.value=''">`).join('')}</div><div data-automation-id="formField-birthDate"><input value="2004-07-15"></div>`);
  assert.equal(await fillWorkdaySignedDate(page,{now:new Date(2026,9,8)}),true);
  assert.deepEqual(await page.locator('[data-automation-id="formField-dateSignedOn"] input').evaluateAll(es=>es.map(e=>e.value)),['10','08','2026']);
  assert.equal(await page.locator('[data-automation-id="formField-birthDate"] input').inputValue(),'2004-07-15');
  await assert.rejects(fillWorkdaySignedDate(page,{now:new Date(2027,0,1),type:async()=>{}}),/did not retain/);
 }finally{await browser.close();}
});
test('Workday discovers alternate combobox buttons, delayed options and verifies saved choices',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<div data-automation-id="formField-age"><label>Are you over 18 years of age? *</label><button role="combobox" aria-required="true" aria-controls="menu" onclick="setTimeout(()=>document.querySelector('#menu').innerHTML='<div role=option onclick=save(this)>Yes</div><div role=option onclick=save(this)>No</div>',50)">Select One</button></div><div id="menu" role="listbox"></div><script>function save(e){document.querySelector('button').innerText=e.innerText;document.querySelector('#menu').innerHTML='';}</script>`);
  const [field]=await readWorkdayFields(page);
  assert.equal(field.kind,'listbox');assert.equal(field.required,true);assert.ok(field.id);
  const result=await selectWorkdayListbox(page,page.locator(`[id="${field.id}"]`),resolveQuestion(field.label,{},ctx).candidates);
  assert.equal(result.ok,true);assert.equal((await readWorkdayFields(page))[0].value,'Yes');
  await page.evaluate(()=>{const button=document.querySelector('button');button.innerText='Select One';const handler=button.onclick;let clicks=0;button.onclick=function(){if(++clicks>1)handler.call(this);};});
  assert.equal((await selectWorkdayListbox(page,page.locator('button'),['No'])).value,'No');
  await page.locator('button').evaluate(e=>e.innerText='Select One');
  await page.evaluate(()=>save=()=>document.querySelector('#menu').innerHTML='');
  const discarded=await selectWorkdayListbox(page,page.locator('button'),['Yes']);
  assert.equal(discarded.ok,false);assert.equal(discarded.technical,true);
 }finally{await browser.close();}
});


test('live age guidance and joined authorization guidance preserve confirmed meaning',()=>{
 assert.equal(pickOption(['Select One','Yes, I am 18 or older.','No, I am not at least 18.'],resolveQuestion('Are you 18 years of age or older? (We comply with State and Federal child labor regulations.)',{},ctx).candidates),'Yes, I am 18 or older.');
 assert.equal(resolveQuestion('3. Are you currently legally authorized to work for Booz Allen Hamilton on a full-time basis for an indefinite period of time in the country where this role is based?If this role is located in the United States, answer Yes/No based on your authorization to work in the United States.If this role is not located in the United States, answer Yes/No based on your authorization to work in the country where the role is based.',{},ctx).candidates[0],'Yes');
 assert.equal(pickOption(['Website - LinkedIn.com','Website - SNCorp.com'],resolveQuestion('How Did You Hear About Us?',{}, {...ctx,company:'Sierra Nevada Corporation'}).candidates),'Website - SNCorp.com');
 assert.equal(pickOption(['Yes','I have never been employed by the U.S. Federal Government.'],resolveQuestion('Have you ever been employed by the U.S. Federal Government?',{}, {...ctx,answers:{...answers,governmentEmployment:'No'}}).candidates),'I have never been employed by the U.S. Federal Government.');
});

test('required skills use only offered exact resume terms and verify retained selections',async()=>{
 const {fillWorkdaySkills}=await import('../src/workday-controls.mjs');
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<div data-automation-id="formField-skills"><label>Type to Add Skills *</label><div data-automation-id="multiselectInputContainer"><input id="skills" data-uxi-widget-type="selectinput" aria-controls="menu" onkeydown="if(event.key==='Enter'){event.preventDefault();show(this.value)}"><button data-automation-id="promptIcon" onclick="show('')">Open</button></div><div id="selected"></div></div><div id="menu" role="listbox"></div><script>function show(q){document.querySelector('#menu').innerHTML=['SolidWorks','Fusion 360','Python'].filter(x=>x.toLowerCase().includes(q.toLowerCase())).map(x=>'<div data-automation-id="promptOption" onclick="save(this)">'+x+'</div>').join('')}function save(e){const s=document.createElement('span');s.dataset.automationId='selectedItem';s.textContent=e.textContent;document.querySelector('#selected').append(s);document.querySelector('#menu').innerHTML='';}</script>`);
  assert.deepEqual(await fillWorkdaySkills(page,['SolidWorks','Fusion 360','Python']),['SolidWorks','Fusion 360','Python']);
  assert.deepEqual(await page.locator('[data-automation-id="selectedItem"]').allTextContents(),['SolidWorks','Fusion 360','Python']);
  await page.locator('#selected').evaluate(e=>e.innerHTML='');
  assert.deepEqual(await fillWorkdaySkills(page,['Invented']),[]);
  assert.equal(await page.locator('[data-automation-id="selectedItem"]').count(),0);
 }finally{await browser.close();}
});


test('Greenhouse qualified citizenship choices use confirmed citizenship, never clearance eligibility',async()=>{
 const label='This job requires a US Q security clearance—a minimum requirement of which is to be a US Citizen. Can you confirm that you are currently a US Citizen? *';
 const result=await resolveUnknownQuestion({question:{label,options:['Yes, I am currently a US Citizen','No, I am not a US Citizen']},profile:{answers},bank:{},job:ctx,execImpl:()=>{throw Error('Unnecessary model call');}});
 assert.equal(result.value,'Yes, I am currently a US Citizen');
 const exportLabel='Astranis complies with U.S. Government space technology export regulations, therefore will you state which of the following applies to you:*';
 assert.equal(resolveQuestion(exportLabel,{},ctx).candidates[0],'I am a U.S. Citizen.');
 assert.equal(resolveQuestion(exportLabel,{}, {...ctx,answers:{}}),null);
 assert.equal(resolveQuestion('Are you eligible for a DOE Q clearance?',{},ctx),null);
});

test('new user answers remain separate from an in-progress degree and unrelated consents',()=>{
 const supplied={...answers,highestCompletedEducation:"Bachelor's Degree",mayContactCurrentEmployer:'Yes',everDischarged:'No',recruitmentSmsConsent:'Yes'};
 const context={...ctx,answers:supplied};
 assert.equal(resolveQuestion('What is your highest level of completed education?',{},context).candidates[0],"Bachelor's Degree");
 assert.equal(resolveQuestion('May we contact your current employer?',{},context).candidates[0],'Yes');
 assert.equal(resolveQuestion('Were you ever discharged by any company?',{},context).candidates[0],'No');
 assert.equal(resolveQuestion('Select YES to receive quick text messages from Astranis regarding interview scheduling, status updates, and logistics for this role. (Message frequency varies. Standard text rates apply. Opt out anytime by replying STOP.)*',{},context).candidates[0],'Yes');
 assert.equal(resolveQuestion('Do you consent to marketing communications such as company news?',{},context),null);
});


test('voluntary veteran disclosure cannot inherit an answer about government contractors',()=>{
 const label='Veteran Status: If you believe you belong to any of the categories of protected veterans listed at the top of this form, please indicate by checking the appropriate box below. As a Government contractor subject to VEVRAA, we request this information.';
 const result=resolveQuestion(label,{}, {...ctx,answers:{...answers,veteranStatus:'I am not a protected veteran',governmentContractorExperience:'No'}});
 assert.equal(pickOption(['I am not a Protected Veteran.','I identify as a protected Veteran.'],result.candidates),'I am not a Protected Veteran.');
 assert.equal(isAcknowledgement('I certify that I have read, fully understand and accept all items of the foregoing statement.'),true);
 assert.equal(isAcknowledgement('I consent to marketing SMS'),false);
});

test('approved AI and marketing consent choices map to full consent statements without another model call',async()=>{
 const {questionId}=await import('../src/companies.mjs');
 for(const [label,answer,options,expected]of[
  ['Use of AI for Future AI Matching (Optional)','Yes',['By checking this box, I consent to the use of AI tools in the recruitment process and matching future jobs.','By checking this box, I consent to the processing of my personal information, but I want to opt out of the use of AI tools.'],0],
  ['Do you consent to receive additional email communications from the company to send me marketing communications?','No',['I consent to receive additional email communications.','I do not consent to receive additional email communications.'],1]]){
  const result=await resolveUnknownQuestion({question:{label,options},profile:{answers},bank:{[questionId(label)]:{answer}},job:ctx,execImpl:()=>{throw Error('No model needed for approved meaning');}});
  assert.equal(result.value,options[expected]);
 }
});

test('an unexpired non-compete follow-up resolves from no restrictive agreements',()=>{
 const label='Do you have a non-compete clause in a contract with your current or former employer that has not yet expired that could impact your ability to work at Dematic in the position for which you have applied?';
 assert.equal(resolveQuestion(label,{}, {...ctx,answers:{...answers,employmentRestrictiveAgreements:'No'}}).candidates[0],'No');
 assert.equal(resolveQuestion(label,{}, {...ctx,answers:{...answers,employmentRestrictiveAgreements:'Yes'}}),null);
});

test('curly apostrophes and race checkbox groups preserve the confirmed choice',async()=>{
 assert.equal(pickOption(['High School Diploma','Bachelor’s Degree','Master’s Degree'],["Bachelor's Degree"]),'Bachelor’s Degree');
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.setContent(`<div data-automation-id="formField-ethnicityMulti"><label>Race/Ethnicity *</label><fieldset data-automation-id="ethnicityMulti-CheckboxGroup" aria-required="true"><input id="asian" type="checkbox"><label for="asian">Asian (United States of America)</label><input id="other" type="checkbox"><label for="other">Other</label></fieldset></div>`);
  const [field]=await readWorkdayFields(page);
  assert.equal(field.kind,'choice-checkbox');assert.deepEqual(field.options,['Asian (United States of America)','Other']);
  const want=pickOption(field.options,resolveQuestion(field.label,{},ctx).candidates);assert.equal(want,'Asian (United States of America)');
  for(const [i,id]of field.optionIds.entries())await setCheckedControl(page,page.locator(`[id="${id}"]`),i===field.options.indexOf(want));
  assert.equal((await readWorkdayFields(page))[0].value,want);assert.equal(await page.locator('#other').isChecked(),false);
 }finally{await browser.close();}
});

test('Merck education abbreviations and citizen sponsorship categories preserve confirmed facts',()=>{
 const context={...ctx,answers:{...answers,highestCompletedEducation:"Bachelor's Degree"}};
 assert.equal(pickOption(['High School Diploma/GED','BA/BS/BSN','MA/MS/MBA'],resolveQuestion('Indicate the highest level of education that you have completed:',{},context).candidates),'BA/BS/BSN');
 const label='Will you require our Company to provide immigration sponsorship now or in the future to have continuous employment eligibility at Our Company?';
 const citizen='N/A – I am a US citizen, US national, legal permanent resident (Green Card holder), granted refugee or granted asylee status.';
 assert.equal(pickOption(['Yes – I hold a temporary visa status.','No – I hold a temporary visa status.',citizen,'N/A - I am not applying to work at a US based location.'],resolveQuestion(label,{},context).candidates),citizen);
 assert.equal(resolveQuestion(label,{}, {...context,location:'London, United Kingdom'}),null);
});

test('a questionnaire graduation date is read as a date and filled from the confirmed profile',async()=>{
 const {workdayDateAnswer,fillWorkdayDate}=await import('../src/workday-controls.mjs');
 assert.deepEqual(workdayDateAnswer('5a. Expected degree completion date.*',{graduationDate:'06/15/2027'}),{key:'graduationDate',Month:6,Day:15,Year:2027});
 assert.equal(workdayDateAnswer('Expected graduation date',{graduationDate:'06/15/2027'}).Year,2027);
 for(const label of ['Date of birth','Start date','When are you available to start?','Expected degree completion date. Explain any delay'])assert.equal(workdayDateAnswer(label,{graduationDate:'06/15/2027'}),null,label);
 assert.equal(workdayDateAnswer('5a. Expected degree completion date.',{}),null);
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();
  const seg=n=>`<div><div data-automation-id="dateSection${n}-display">${n}</div><input role="spinbutton" data-automation-id="dateSection${n}-input" value=""></div>`;
  await page.setContent(`<div data-automation-id="formField-x"><fieldset><legend><p>5a. Expected degree completion date.<abbr>*</abbr></p></legend><div id="primaryQuestionnaire--x" data-automation-id="dateInputWrapper">${['Month','Day','Year'].map(seg).join('/')}</div></fieldset></div>`);
  const [f]=await readWorkdayFields(page);
  assert.deepEqual([f.kind,f.id,f.value],['date','primaryQuestionnaire--x','']);
  assert.match(f.label,/^5a\. Expected degree completion date\./);
  assert.equal(await fillWorkdayDate(page,page.locator('[id="primaryQuestionnaire--x"]'),workdayDateAnswer(f.label,{graduationDate:'06/15/2027'})),true);
  assert.equal((await readWorkdayFields(page))[0].value,'06/15/2027');
 }finally{await browser.close();}
});

// ASML 9067: a required listbox with no saved answer was parked without its choices, so the
// current-status fact rule, the agent and the approval card all worked blind.
test('a closed listbox is read for its choices without selecting one',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<div data-automation-id="formField-status"><label>Please indicate your current status. *</label><button id="status" aria-haspopup="listbox" onclick="document.querySelector('#menu').hidden=false">Select One</button></div>
  <ul id="menu" role="listbox" hidden><li role="option">Select One</li><li role="option" onclick="document.querySelector('#status').innerText=this.innerText">U.S. Citizen</li><li role="option">H-1B</li></ul>`);
  assert.deepEqual(await readWorkdayListboxOptions(page,page.locator('#status'),{wait:async()=>{}}),['Select One','U.S. Citizen','H-1B']);
  assert.equal((await page.locator('#status').innerText()).trim(),'Select One');
  const field=(await readWorkdayFields(page))[0];
  assert.equal(field.kind,'listbox');assert.equal(field.value,'');
  assert.equal(resolveQuestion('Please indicate your current status.',{}, {...ctx,options:['Select One','U.S. Citizen','H-1B']}).candidates[0],'U.S. Citizen');
  assert.deepEqual(await readWorkdayListboxOptions(page,page.locator('#missing'),{wait:async()=>{}}),[]);
 }finally{await browser.close();}
});

// ASML 9067: the chosen option's textContent had a double space and a line break, so the exact
// regex never matched and the click waited out its timeout with the menu open.
test('a listbox option whose raw text wraps and double-spaces is still clicked',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  const long='U.S. Citizen, U.S. Lawful Permanent Resident (Green Card Holder) or Person granted Refugee or Asylee status by the U.S. Government.  Select category below if you have a pending application for Lawful Permanent Resident,\nRefugee or Asylee status.';
  await page.setContent(`<div data-automation-id="formField-status"><label>Please indicate your current status. *</label><button id="status" aria-haspopup="listbox" onclick="document.querySelector('#menu').hidden=false">Select One</button></div>
  <ul id="menu" role="listbox" hidden><li role="option">Select One</li><li role="option" onclick="document.querySelector('#status').innerText=this.innerText;this.parentElement.hidden=true"><div>${long}</div></li><li role="option">All others, including: Visa Holder</li></ul>`);
  const res=await selectWorkdayListbox(page,page.locator('#status'),['U.S. Citizen'],{wait:async()=>{}});
  assert.equal(res.ok,true,JSON.stringify(res).slice(0,200));
  assert.match(res.value,/^U\.S\. Citizen, U\.S\. Lawful/);
 }finally{await browser.close();}
});
