import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {snapshot} from '../src/dashboard-worker.mjs';

// Intuitive 12315 screening page (lesson 428): the "would you consider relocation?" select is an <spl-autocomplete>
// whose shadow <label> shows only the "*" required mark; the question text is slotted light DOM. The card asked
// him to answer "*" with Yes / No / N/A. The slotted question is now the control's label, as for the "*" checkbox.
test('a shadow-DOM select whose own label is "*" takes the slotted question text',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  const url='https://jobs.smartrecruiters.com/oneclick-ui/company/Example/publication/z/screening';
  await page.route(url,r=>r.fulfill({contentType:'text/html',body:'<main><spl-autocomplete id="question_1" required><span slot="label-content">If you live in one of these states, would you consider relocation?</span></spl-autocomplete><input aria-label="What is your postal code?" required></main>'}));
  await page.goto(url);
  await page.evaluate(()=>{document.querySelector('spl-autocomplete').attachShadow({mode:'open'}).innerHTML='<label for="i1" id="i1-label"><slot name="label-content"></slot><span aria-hidden="true">*</span></label><input id="i1" type="text" role="combobox" aria-labelledby="i1-label" aria-required="true">';});
  const controls=(await snapshot(page)).frames.flatMap(f=>f.controls);
  const select=controls.find(c=>/consider relocation/.test(c.label));
  assert.ok(select,JSON.stringify(controls.map(c=>c.label)));
  assert.ok(!controls.some(c=>c.label==='*'),JSON.stringify(controls.map(c=>c.label)));
 }finally{await browser.close();}
});

// Intuitive 12315 (lesson 430): the export-control select slots a whole notice before its question, so the rendered
// text was too long for a label and the control still read "*". The sentences from the last question onwards are kept.
test('a long slotted label keeps the question that ends it',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  const url='https://jobs.smartrecruiters.com/oneclick-ui/company/Example/publication/w/screening';
  const notice='U.S. EXPORT COMPLIANCE ASSESSMENT Please read and respond carefully. Under applicable laws and regulations, the company may be required to apply for a U.S. export license, or implement other controls, on the applicant\'s behalf. The following questions are solely used as part of a standard export compliance assessment to make that determination. The information you provide in this section will only be reviewed by our Compliance team (not hiring personnel), and only if the job to which you are applying involves certain technical data or technology that may implicate export controls. Such conditions do not preclude employment, rather, they enable the company to hire globally in accordance with U.S. regulations. When answering the below questions, do not include work permits, study permits, or other temporary residence statuses, which do not apply to export control determinations. Export controls do not apply to U.S. Persons. Are you a U.S. Citizen, a Lawful Permanent Resident (issued an alien registration card from the U.S. government), a Lawful Asylee, or a Lawful Refugee of the United States? (note: an inaccurate answer could cause delay to the hiring process.)';
  await page.route(url,r=>r.fulfill({contentType:'text/html',body:`<main><spl-autocomplete id="question_2" required><span slot="label-content">${notice}</span></spl-autocomplete></main>`}));
  await page.goto(url);
  await page.evaluate(()=>{document.querySelector('spl-autocomplete').attachShadow({mode:'open'}).innerHTML='<label for="i2" id="i2-label"><slot name="label-content"></slot><span aria-hidden="true">*</span></label><input id="i2" type="text" role="combobox" aria-labelledby="i2-label" aria-required="true">';});
  const controls=(await snapshot(page)).frames.flatMap(f=>f.controls);
  const select=controls.find(c=>/^Are you a U\.S\. Citizen, a Lawful Permanent Resident/.test(c.label));
  assert.ok(select,JSON.stringify(controls.map(c=>c.label.slice(0,80))));
  assert.ok(select.label.length<400,select.label);
 }finally{await browser.close();}
});
