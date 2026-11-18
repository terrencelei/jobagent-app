import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readWorkdayFields,workdayDateAnswer,fillWorkdayDate} from '../src/workday-controls.mjs';

const question='When do you expect to complete your current degree program?';
// Synthetic facts only; mirror the saved secondary-questionnaire segmented control.
const answers={graduationDate:'06/12/2028'};

test('degree-program completion wording uses only the confirmed graduation date',()=>{
 assert.deepEqual(workdayDateAnswer(`${question}*\u00a0`,answers),{key:'graduationDate',Month:6,Day:12,Year:2028});
 assert.equal(workdayDateAnswer(question,{}),null);
 for(const label of ['When do you expect to complete your training program?',
  'When do you expect to complete your current degree program? Explain any delay',
  'When do you expect to start your current degree program?',
  'When do you expect to complete your future degree program?'])
  assert.equal(workdayDateAnswer(label,answers),null,label);
});

test('secondary questionnaire degree completion date is discovered, typed and retained',async()=>{
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();
  const segment=part=>`<div><div data-automation-id="dateSection${part}-display" onclick="window.activePart='${part}'">${part}</div><input role="spinbutton" aria-label="${part}" data-part="${part}" data-automation-id="dateSection${part}-input" oninput="if(window.activePart!==this.dataset.part)this.value=''" value=""></div>`;
  await page.setContent(`<div data-automation-id="formField-degree"><fieldset><legend><div data-automation-id="richText"><p>${question}<abbr title="required">*</abbr>&nbsp;</p></div></legend><div role="group" id="secondaryQuestionnaire--degree" data-automation-id="dateInputWrapper">${['Month','Day','Year'].map(segment).join('/')}</div></fieldset></div>`);
  const [field]=await readWorkdayFields(page);
  assert.deepEqual([field.kind,field.required,field.value],['date',true,'']);
  const date=workdayDateAnswer(field.label,answers);
  assert.ok(date,'required completion date must resolve before advancing');
  assert.equal(await fillWorkdayDate(page,page.locator('[id="secondaryQuestionnaire--degree"]'),date),true);
  await page.keyboard.press('Tab');
  assert.equal((await readWorkdayFields(page))[0].value,answers.graduationDate);
 }finally{await browser.close();}
});

test('Workday earliest-start-date questions take his confirmed start date (Cisco 12281)',()=>{
 const answers={earliestStartDate:'2027-06-16'};
 for(const q of ['What is the earliest date you could start?*','Earliest start date','When can you start?'])assert.deepEqual(workdayDateAnswer(q,answers),{key:'earliestStartDate',Month:6,Day:16,Year:2027},q);
 assert.equal(workdayDateAnswer('What is the earliest date you could start?',{}),null);
 assert.equal(workdayDateAnswer('Date of birth',answers),null);
});

test('a bare graduation-date question takes the confirmed graduation date (Blue Origin 12799)',()=>{
 for(const q of ['What is your graduation date?*','Graduation date','What is your graduation date?\u00a0'])assert.deepEqual(workdayDateAnswer(q,answers),{key:'graduationDate',Month:6,Day:12,Year:2028},q);
 assert.equal(workdayDateAnswer('What is your graduation date?',{}),null);
 for(const q of ['What was your graduation date from high school?','Graduation date of your most recent certification'])assert.equal(workdayDateAnswer(q,answers),null,q);
});

test('a date he approved on the card for the exact question is typed, not re-flagged (Blue Origin 12799)',()=>{
 const approved=[{question:'What is your graduation date?',answer:'06/15/2027'},{question:'Date of last physical',answer:'2026-01-09'}];
 assert.deepEqual(workdayDateAnswer('What is your graduation date?*',{},approved),{key:'approved',Month:6,Day:15,Year:2027});
 assert.deepEqual(workdayDateAnswer('Date of last physical',{},approved),{key:'approved',Month:1,Day:9,Year:2026});
 assert.equal(workdayDateAnswer('Date of birth',{},approved),null);
 assert.equal(workdayDateAnswer('Date of birth',{},[{question:'Date of birth',answer:'unknown'}]),null);
});
