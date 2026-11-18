import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {isResumeOnlyExperience} from '../src/workday-experience-layout.mjs';
import {reconcileWorkdayHistory,ensureWorkdayEducationRows,savedWorkdayHistoryProblems} from '../src/workday-history.mjs';

const history=[{company:'Fixture Employer',title:'Engineer',from:['1','2025'],to:null}];
const education=[{school:'Fixture School',degree:'Bachelor',field:'Engineering',from:['8','2020'],to:['6','2024']}];
// Saved failure layout, with synthetic values: only Resume/CV and LinkedIn are offered.
const fixture=`<h2>My Experience</h2><section><h3>Resume/CV</h3>
<div data-automation-id="attachments-FileUpload"><input type="file"></div>
<div data-automation-id="file-upload-successful">Successfully Uploaded!</div>
<button data-automation-id="delete-file" onclick="window.deleted=true">Delete fixture.pdf</button></section>
<label>LinkedIn<input id="socialNetworkAccounts--linkedInAccount"></label>
<button data-automation-id="pageFooterNextButton">Save and Continue</button>`;

test('GM resume-only form with two saved websites records omitted history without touching controls',async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  await page.setContent(fixture.replace('<h3>Resume/CV</h3>','<h3>Resume/CV Only</h3>')
   .replace('<label>LinkedIn<input id="socialNetworkAccounts--linkedInAccount"></label>',
    `<section><h3>Websites</h3>
    <label>URL<input id="webAddress-4--url" value="https://example.org/profile"></label>
    <label>URL<input id="webAddress-5--url" value="https://example.org/projects"></label>
    <button onclick="window.deleted=true">Delete</button>
    <button data-automation-id="add-button" onclick="window.websiteAdded=true">Add Another</button></section>`));
  const before=await page.content(),audit=[];
  const required=!await isResumeOnlyExperience(page);
  assert.equal(required,false);
  assert.deepEqual(await reconcileWorkdayHistory(page,history,{onAudit:(stage,rows)=>audit.push({stage,rows})}),[]);
  assert.deepEqual(audit,[{stage:'not-offered',rows:[]}]);
  assert.deepEqual(await ensureWorkdayEducationRows(page,education),[]);
  assert.deepEqual(await savedWorkdayHistoryProblems(page,[],history,{required}),[]);
  assert.equal(await page.content(),before);
  // A successful upload alone cannot excuse a newly offered history section.
  await page.locator('body').evaluate(el=>el.insertAdjacentHTML('beforeend','<h3>Work Experience</h3>'));
  assert.ok((await savedWorkdayHistoryProblems(page,[],history,{required})).includes('1 missing rows'));
 } finally {await browser.close();}
});

test('Resume/CV Only with Websites omits history and verifies the saved form',async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  // GM's saved failure layout, with synthetic website values and no personal data.
  const gm=fixture.replace('<h3>Resume/CV</h3>','<h3>Resume/CV Only</h3>')
   .replace('<label>LinkedIn<input id="socialNetworkAccounts--linkedInAccount"></label>',
    '<section><h3>Websites</h3><label>URL<input id="webAddress-1--url" value="https://example.org"></label><button data-automation-id="add-button" onclick="window.websiteAdded=true">Add Another</button></section>');
  await page.setContent(gm);
  assert.equal(await isResumeOnlyExperience(page),true);
  assert.deepEqual(await reconcileWorkdayHistory(page,history),[]);
  assert.deepEqual(await ensureWorkdayEducationRows(page,education),[]);
  assert.deepEqual(await savedWorkdayHistoryProblems(page,[],history,{required:false}),[]);
  assert.equal(await page.evaluate(()=>Boolean(window.deleted||window.websiteAdded)),false);
  for(const extra of ['<h3>Work Experience</h3>','<h3>Education</h3>',
   '<div role="progressbar">Loading</div>','<div>Something went wrong. Please refresh the page</div>']) {
   await page.setContent(gm+extra);
   assert.equal(await isResumeOnlyExperience(page),false,extra);
   assert.ok((await savedWorkdayHistoryProblems(page,[],history,{required:false})).includes('1 missing rows'));
  }
  await page.setContent(gm.replace('file-upload-successful','file-upload-pending'));
  assert.equal(await isResumeOnlyExperience(page),false);
  await page.setContent(gm);
  await page.locator('[data-automation-id="pageFooterNextButton"]').evaluate(el=>el.disabled=true);
  assert.equal(await isResumeOnlyExperience(page),false);
 } finally {await browser.close();}
});

test('resume-only experience does not demand absent work or education controls',async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();await page.setContent(fixture);
  assert.deepEqual(await reconcileWorkdayHistory(page,history),[]);
  assert.deepEqual(await ensureWorkdayEducationRows(page,education),[]);
  assert.equal(await page.evaluate(()=>Boolean(window.deleted)),false);
 } finally {await browser.close();}
});

test('missing Add controls, loading forms and error pages are never treated as resume-only',async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  for(const extra of ['<h3>Work Experience</h3>','<h3>Education</h3>',
   '<input id="workExperience-1--jobTitle">','<div role="progressbar">Loading</div>',
   '<div>Something went wrong. Please refresh the page</div>',
   '<div data-automation-id="errorBanner">Error - Page Error</div>']) {
   await page.setContent(fixture+extra);
   assert.equal(await isResumeOnlyExperience(page),false,extra);
  }
  await page.setContent(fixture+'<h3>Work Experience</h3>');
  await assert.rejects(reconcileWorkdayHistory(page,history),/Cannot identify the Work Experience Add control/);
  await page.setContent(fixture+'<h3>Education</h3>');
  await assert.rejects(ensureWorkdayEducationRows(page,education),/Cannot identify the Education Add control/);
  await page.setContent(fixture);
  await page.locator('[data-automation-id="pageFooterNextButton"]').evaluate(el=>el.disabled=true);
  assert.equal(await isResumeOnlyExperience(page),false);
  await page.setContent(fixture.replace('file-upload-successful','file-upload-pending'));
  assert.equal(await isResumeOnlyExperience(page),false);
 } finally {await browser.close();}
});


test('saved resume-only layout is rechecked and offered history cannot disappear after saving',async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();await page.setContent(fixture);
  assert.deepEqual(await savedWorkdayHistoryProblems(page,[],history,{required:false}),[]);
  assert.ok((await savedWorkdayHistoryProblems(page,[],history)).includes('1 missing rows'));
  // A saved-page round trip must still show the complete resume-only form.
  await page.setContent(fixture.replace('file-upload-successful','file-upload-pending'));
  assert.ok((await savedWorkdayHistoryProblems(page,[],history,{required:false})).includes('1 missing rows'));
  await page.setContent(fixture+'<h3>Work Experience</h3>');
  assert.ok((await savedWorkdayHistoryProblems(page,[],history,{required:false})).includes('1 missing rows'));
 } finally {await browser.close();}
});
