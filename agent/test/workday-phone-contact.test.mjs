import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openWorkdayBrowser} from '../src/workday-browser.mjs';
import {readWorkdayFields} from '../src/workday-controls.mjs';
import {resolveQuestion,needsWorkdayAnswer} from '../src/workday.mjs';
import {profileFact} from '../src/profile-facts.mjs';

const phone='2025550199';
const consent='Yes - I consent to receiving text messages';
const bank={'phone number':{question:'Phone Number',answer:consent,type:'select',approvedFor:'different-role'}};

test('saved contact phone repairs a consent-contaminated Workday input and advances locally',async()=>{
 const root=await mkdtemp(join(tmpdir(),'workday-phone-contact-'));
 let context;
 try{
  context=await openWorkdayBrowser(chromium,join(root,'profile'),{headless:true,viewport:{width:1280,height:1000}});
  const page=context.pages()[0];
  await page.setContent(`<main>My Information</main><div data-automation-id="formField-phoneNumber">
   <label for="phoneNumber--phoneNumber">Phone Number<abbr>*</abbr></label>
   <input type="text" id="phoneNumber--phoneNumber" name="phoneNumber" aria-required="true" aria-invalid="true" value="${consent}">
   <p data-automation-id="inputAlert">Enter a valid format for Phone Number.</p></div>
   <button data-automation-id="pageFooterNextButton">Save and Continue</button>
   <script>window.saves=0;document.querySelector('button').onclick=()=>{saves++;
   if(/^\\d{10}$/.test(document.querySelector('input').value))document.querySelector('main').textContent='My Experience';};</script>`);
  const [field]=await readWorkdayFields(page);
  assert.equal(field.label.replace(/\s*\*$/,''),'Phone Number');
  const known=resolveQuestion(field.label,bank,{answers:{phone},options:field.options});
  assert.deepEqual(known?.candidates,[phone]);
  assert.equal(known.source,'profile');
  assert.equal(needsWorkdayAnswer(field,known),true);
  const input=page.locator('[id="phoneNumber--phoneNumber"]');
  await input.fill(known.candidates[0]);await input.press('Tab');
  await page.getByRole('button',{name:'Save and Continue',exact:true}).click();
  assert.equal(await page.locator('main').innerText(),'My Experience');
  assert.equal(await page.evaluate(()=>saves),1);
 }finally{await context?.close();await rm(root,{recursive:true,force:true});}
});

test('phone contact and a Phone Number consent select remain distinct',()=>{
 const options=[consent,'No - I do not consent to receiving text messages'];
 assert.equal(profileFact('Phone Number',{phone},{options}),null);
 assert.deepEqual(resolveQuestion('Phone Number',bank,{answers:{phone},options}).candidates,[consent]);
 assert.equal(profileFact('Phone Number',{}),null);
 assert.equal(profileFact('Phone Device Type',{phone}),null);
 assert.equal(profileFact('Country Phone Code',{phone}),null);
 assert.equal(profileFact('Phone Extension',{phone}),null);
 for(const label of ['Phone','Phone Number','Phone Number *']){
  assert.deepEqual(resolveQuestion(label,bank,{answers:{phone},approvedAnswers:[{question:label,answer:consent}]}).candidates,[phone]);
 }
});
