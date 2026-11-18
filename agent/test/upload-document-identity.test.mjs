import test from 'node:test';import assert from 'node:assert/strict';import{chromium}from'playwright';
import{snapshot,uploadDocument}from'../src/dashboard-worker.mjs';
import {createServer} from 'node:http';
import {readWorkdayFields} from '../src/workday-controls.mjs';
import {resolveQuestion} from '../src/workday.mjs';

test('anonymous Rippling upload inputs inherit only their own document heading',async()=>{
 const server=createServer((_req,res)=>res.end('<html></html>'));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch();try{
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.setContent('<form><div><div>Résumé*</div><div>Total 0 file selected<label>Drop or select (.doc / .docx / .pdf)<input type="file"></label></div></div><div><div>Cover letter</div><div>Total 0 file selected<label>Drop or select (.doc / .docx / .pdf)<input type="file"></label></div></div></form>');
  const files=(await snapshot(page)).frames[0].controls.filter(c=>c.type==='file');
  assert.equal(files.length,2);assert.match(files[0].label,/Résumé\*/);assert.equal(files[0].required,true);
  assert.match(files[1].label,/Cover letter/);assert.equal(files[1].required,false);
  assert.deepEqual(uploadDocument(files[0].label,'original.pdf'),{kind:'resume',path:'original.pdf'});
  assert.equal(uploadDocument(files[1].label,'original.pdf'),null);
  await page.setContent('<form><h2>Résumé</h2><label>Drop or select<input type="file"></label><label>Drop or select<input type="file"></label></form>');
  for(const file of (await snapshot(page)).frames[0].controls.filter(c=>c.type==='file'))assert.equal(uploadDocument(file.label,'original.pdf'),null);
 }finally{await browser.close();await new Promise(r=>server.close(r))}
});

test('Workday select-all questions expose their real checkbox choices instead of a synthetic Yes/No',async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage();
  const label='The following statements are intended to preliminarily identify potential restrictions that may arise as a result of your government service. (Select all that apply)';
  await page.setContent(`<div data-automation-id="formField-government"><label>${label}*</label><label><input type="checkbox" id="government" required>Former government employment</label><label><input type="checkbox" id="none">None of the above.</label></div>`);
  const fields=await readWorkdayFields(page);assert.equal(fields.length,1);assert.equal(fields[0].kind,'choice-checkbox');
  assert.deepEqual(fields[0].options,['Former government employment','None of the above.']);
  const answer=resolveQuestion(label,{[label.toLowerCase()]:{answer:'No'}},{answers:{governmentEmployment:'No'},options:fields[0].options});
  assert.equal(answer.candidates[0],'None of the above.');
 }finally{await browser.close()}
});
