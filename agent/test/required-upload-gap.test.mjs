import test from 'node:test';import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {snapshot,missingRequiredUploads} from '../src/dashboard-worker.mjs';
// Varda 9948 (Greenhouse): the required Cover Letter upload stayed empty, the run submitted
// anyway and the employer answered "Cover Letter is required."
const upload=(id,title,required)=>`<div class="file-upload" role="group" aria-labelledby="upload-label-${id}"><div id="upload-label-${id}">${title}${required?'<span>*</span>':''}</div><div class="result"></div><label>Attach<input id="${id}" type="file" class="visually-hidden"></label></div>`;
test('a required cover-letter upload with no file blocks Submit',async()=>{
 const server=createServer((_req,res)=>res.end('<html></html>'));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.setContent(`<form>${upload('resume','Resume/CV',true)}${upload('cover_letter','Cover Letter',true)}${upload('other','Additional documents',false)}<button type="submit">Submit application</button></form>`);
  let controls=(await snapshot(page)).frames.flatMap(f=>f.controls);
  assert.deepEqual(missingRequiredUploads(controls),['Cover Letter* (Attach)']);
  // Greenhouse shows the accepted filename in the group once the upload lands.
  await page.locator('#cover_letter').evaluate(el=>{el.closest('.file-upload').querySelector('.result').innerHTML='<div class="file-upload__filename">letter.pdf</div>';});
  controls=(await snapshot(page)).frames.flatMap(f=>f.controls);
  assert.deepEqual(missingRequiredUploads(controls),[]);
  await page.setContent(`<form>${upload('cover_letter','Cover Letter',false)}<button>Submit</button></form>`);
  assert.deepEqual(missingRequiredUploads((await snapshot(page)).frames.flatMap(f=>f.controls)),[]);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});
