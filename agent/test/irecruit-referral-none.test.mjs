import test from 'node:test';import assert from 'node:assert/strict';import{chromium}from'playwright';
import {preferenceAnswer} from '../src/applicant-preferences.mjs';
import {snapshot} from '../src/dashboard-worker.mjs';

// Piper Aircraft 13354 (iRecruit): the Employment Preferences section asks
// "If referred by a current employee please provide name here. If not please type “None” *".
// The worker left it blank as an optional unknown and Save/Next failed validation.
const label='If referred by a current employee please provide name here. If not please type “None” *';

test('the referral-name box types the "None" its label dictates when his connections default is No',()=>{
 const got=preferenceAnswer(label,{employerConnectionsDefault:'No'},{company:'Piper Aircraft Inc'});
 assert.equal(got?.value,'None');
 assert.equal(got.authoritative,true);
 assert.equal(preferenceAnswer('If you were referred by a current employee, provide the name. If none, enter N/A',{employerConnectionsDefault:'No'})?.value,'N/A');
 // No saved default, or a bank answer admitting a referral, keeps it a question for him.
 assert.equal(preferenceAnswer(label,{}),null);
 assert.equal(preferenceAnswer(label,{employerConnectionsDefault:'No'},{bank:{x:{question:'Were you referred by a current employee?',answer:'Yes'}}}),null);
 // A plain "who referred you" box without the None instruction stays unanswered.
 assert.equal(preferenceAnswer('Name of the employee who referred you',{employerConnectionsDefault:'No'}),null);
});

test('a trailing asterisk on a plain input label marks it required when the page sets no attribute',async()=>{
 const browser=await chromium.launch();try{const page=await browser.newPage();
  await page.route('http://localhost/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<html></html>'}));await page.goto('http://localhost/fixture');
  await page.setContent(`<form><label for="ref">${label}</label><input id="ref" type="text"><label for="li">LinkedIn:</label><input id="li" type="text"><input type="submit" value="Save/Next"></form>`);
  const fields=(await snapshot(page)).frames[0].controls.filter(c=>c.type==='text');
  assert.equal(fields.length,2);
  assert.equal(fields[0].required,true,'label ending in nbsp+* is required');
  assert.equal(fields[1].required,false,'LinkedIn: stays optional');
 }finally{await browser.close();}
});
