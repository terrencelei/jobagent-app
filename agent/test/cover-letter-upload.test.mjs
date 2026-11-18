import test from 'node:test';import assert from 'node:assert/strict';
import{uploadDocument}from'../src/dashboard-worker.mjs';
import{FORM_AGENT_INSTRUCTIONS}from'../src/application-decision-context.mjs';

test('an approved cover letter fills the cover-letter upload only',()=>{
 const documents={coverLetter:'private/cover-letters/9948/Alex_Rivera_Cover_Letter.pdf',portfolio:'p.pdf'};
 assert.deepEqual(uploadDocument('Cover Letter* (Attach)','resume.pdf',documents),{kind:'cover letter',path:documents.coverLetter});
 assert.deepEqual(uploadDocument('Resume/CV* (Attach)','resume.pdf',documents),{kind:'resume',path:'resume.pdf'});
 assert.equal(uploadDocument('Cover Letter (Attach)','resume.pdf',{}),null);
 assert.match(FORM_AGENT_INSTRUCTIONS,/coverLetter\) appears in confirmedDocuments/);
});

test('a JazzHR attach link with no file chooser falls back to its own hidden input',async()=>{
 const {chromium}=await import('playwright');const {setHiddenUpload}=await import('../src/dashboard-worker.mjs');
 const {writeFile,mkdtemp}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const dir=await mkdtemp(join(tmpdir(),'jazz-'));const file=join(dir,'Alex_Rivera_Portfolio.pdf');await writeFile(file,'%PDF-1.4');
 const browser=await chromium.launch();try{
  const page=await browser.newPage();
  await page.setContent('<label for="resumator-resume-value">Resume*</label><input type="file" id="resumator-resume-value" hidden><label for="resumator-questionnaire-file-1">If you have a portfolio, please upload it here.</label><input type="file" id="resumator-questionnaire-file-1" hidden>');
  assert.equal(await setHiddenUpload(page.mainFrame(),'portfolio',file),true);
  assert.equal(await page.$eval('#resumator-questionnaire-file-1',e=>e.files[0]?.name),'Alex_Rivera_Portfolio.pdf');
  assert.equal(await page.$eval('#resumator-resume-value',e=>e.files.length),0);
  assert.equal(await setHiddenUpload(page.mainFrame(),'cover letter',file),false);
 }finally{await browser.close()}
});

test('empty hidden document inputs are filled before Submit (JazzHR resume behind an Attach link)',async()=>{
 const {chromium}=await import('playwright');const {fillHiddenDocuments}=await import('../src/dashboard-worker.mjs');
 const {writeFile,mkdtemp}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const dir=await mkdtemp(join(tmpdir(),'jazz-'));const resume=join(dir,'Alex_Rivera_Resume.pdf');const portfolio=join(dir,'Alex_Rivera_Portfolio.pdf');
 await writeFile(resume,'%PDF-1.4');await writeFile(portfolio,'%PDF-1.4');
 const browser=await chromium.launch();try{
  const page=await browser.newPage();
  await page.setContent('<label for="resumator-resume-value">Resume*</label><input type="file" id="resumator-resume-value" hidden><label for="q1">If you have a portfolio, please upload it here.</label><input type="file" id="q1" hidden><label for="q2">Other attachment</label><input type="file" id="q2" hidden><label for="gh">Resume/CV</label><input type="file" id="gh" style="position:absolute;width:1px;height:1px;opacity:0">');
  const filled=await fillHiddenDocuments(page.frames(),resume,{portfolio});
  assert.deepEqual(filled.map(f=>f.kind),['resume','portfolio']);
  assert.equal(await page.$eval('#gh',e=>e.files.length),0);  // Greenhouse-style rendered input: left to the upload step
  assert.equal(await page.$eval('#resumator-resume-value',e=>e.files[0]?.name),'Alex_Rivera_Resume.pdf');
  assert.equal(await page.$eval('#q2',e=>e.files.length),0);
  assert.deepEqual(await fillHiddenDocuments(page.frames(),resume,{portfolio}),[]);  // already attached: nothing redone
 }finally{await browser.close()}
});
