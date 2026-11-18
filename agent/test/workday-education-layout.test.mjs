import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {ensureWorkdayEducationRows} from '../src/workday-history.mjs';

const education=[{school:'Fixture University',degree:'Bachelor',field:'Engineering',from:['9','2020'],to:['6','2024']}];
const fixture=(extra='',footer='')=>`<h2>My Experience</h2>
<section><h3>Work Experience</h3><input id="workExperience-1--jobTitle" value="Engineer">
<button data-automation-id="add-button" onclick="window.wrongAdd=true">Add Another</button></section>
<section><h3>Skills</h3><input id="skills--skills"></section>
<section><h3>Resume/CV/Cover Letter/Qualifications</h3><div data-automation-id="file-upload-successful">Successfully Uploaded!</div></section>
${extra}<button data-automation-id="pageFooterNextButton" ${footer}>Save and Continue</button>`;

test('loaded work-and-resume form without Education requires no education rows or Add clicks',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.setContent(fixture());
  assert.deepEqual(await ensureWorkdayEducationRows(page,education),[]);
  assert.deepEqual(await ensureWorkdayEducationRows(page,undefined),[]);
  assert.equal(await page.evaluate(()=>window.wrongAdd),undefined);
  assert.equal(await page.locator('[id="workExperience-1--jobTitle"]').inputValue(),'Engineer');
 }finally{await browser.close();}
});

test('education presence, loading, incomplete forms and employer errors still block missing Add controls',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  const cases=[
   fixture('<section><h3>Education</h3></section>'),
   fixture('<div data-fkit-id="education--schoolName"></div>'),
   fixture('<input id="education-1--schoolName">'),
   fixture('<div aria-busy="true">Loading</div>'),
   fixture('<div role="progressbar">Loading</div>'),
   fixture('<div data-automation-id="errorBanner">Error</div>'),
   fixture('<p>Something went wrong. Please refresh the page.</p>'),
   fixture('', 'disabled'),fixture('', 'aria-disabled="true"'),
   fixture().replace('file-upload-successful','not-uploaded'),
   fixture().replace('My Experience','Loading'),
   '<h2>My Experience</h2>',
  ];
  for(const html of cases){
   await page.setContent(html);
   await assert.rejects(ensureWorkdayEducationRows(page,[...education,...education]),/Cannot identify the Education Add control/);
   assert.equal(await page.evaluate(()=>window.wrongAdd),undefined);
  }
 }finally{await browser.close();}
});
