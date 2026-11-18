import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {snapshot} from '../src/dashboard-worker.mjs';

const name=i=>`job_applicant[custom_form_response_attributes][answers_attributes][${i}]`;
const prefix=i=>`job_applicant_custom_form_response_attributes_answers_attributes_${i}_`;
const question=(i,label,content)=>`<div><input type="hidden" name="${name(i)}[question_uuid]" value="fixture-${i}"><label for="${prefix(i)}${label.replace('?','')}">${label}</label><div>${content}</div></div>`;
test('Gusto orphan labels stay with their exact custom question and radio options',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.route('http://localhost/fixture',r=>r.fulfill({contentType:'text/html',body:'<html></html>'}));
  await page.goto('http://localhost/fixture');
  await page.setContent(`<form>${question(0,'How many years of relevant experience do you have?',`<input required name="${name(0)}[text]" id="${prefix(0)}text">`)}
   ${question(1,'What is the earliest date you are available to start this position?',`<input required name="${name(1)}[text]" id="${prefix(1)}text">`)}
   ${question(2,'Are you a US Citizen?',`<label for="${prefix(2)}yes"><input type="radio" name="${name(2)}[options][]" id="${prefix(2)}yes">Yes</label><label for="${prefix(2)}no"><input type="radio" name="${name(2)}[options][]" id="${prefix(2)}no">No</label>`)}
   <label for="ordinary">Ordinary field</label><input id="ordinary" name="ordinary">
   ${question(3,'Ambiguous heading A',`<label for="${prefix(3)}other">Ambiguous heading B</label><input name="${name(3)}[text]" id="${prefix(3)}text">`)}
   <div><label for="${prefix(4)}wrong">Unrelated heading</label><input name="${name(4)}[text]" id="${prefix(4)}text"></div>
  </form>`);
  const snap=await snapshot(page);const controls=snap.frames[0].controls;
  assert.equal(controls.find(c=>c.name===`${name(0)}[text]`).label,'How many years of relevant experience do you have?');
  assert.equal(controls.find(c=>c.name===`${name(1)}[text]`).label,'What is the earliest date you are available to start this position?');
  const radios=controls.filter(c=>c.type==='radio');
  assert.deepEqual(radios.map(c=>c.label),['Are you a US Citizen?','Are you a US Citizen?']);
  assert.deepEqual(radios.map(c=>c.optionLabel),['Yes','No']);
  assert.deepEqual(radios[0].choiceLabels,['Yes','No']);
  assert.equal(controls.find(c=>c.name==='ordinary').label,'Ordinary field');
  for(const i of [3,4])assert.equal(controls.find(c=>c.name===`${name(i)}[text]`).label,`${name(i)}[text]`);
 }finally{await browser.close();}
});
