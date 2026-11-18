import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {openUploadMenuItem} from '../src/dashboard-worker.mjs';

// Jobvite (AGS 13110): 'Select' opens Dropbox / File / Paste; only the 'File' label opens the chooser.
const JOBVITE=`<h3 id="hdr">Add Resume*</h3>
<button id="select" type="button" aria-haspopup="true" aria-labelledby="hdr" onclick="document.getElementById('menu').hidden=false">Select</button>
<div id="menu" role="dialog" hidden>
 <span role="button" tabindex="0" onclick="window.dropbox=true">Dropbox</span>
 <label for="file-input-0"><span role="button" tabindex="0">File</span></label>
 <input id="file-input-0" type="file" style="position:absolute;width:1px;height:1px;clip:rect(0,0,0,0)" onchange="window.picked=this.files[0].name">
 <span role="button" tabindex="0">Type or Paste Resume</span>
 <button type="button">Apply With LinkedIn</button>
</div>
<input id="file-input-1" type="file" style="position:absolute;width:1px;height:1px;clip:rect(0,0,0,0)">`;

test('an upload button that opens a source menu uses its local File item',async()=>{
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();await page.setContent(JOBVITE);
  assert.equal(await openUploadMenuItem(page),null,'closed menu offers no item');
  await page.click('#select');
  const chooser=await openUploadMenuItem(page);
  assert.ok(chooser,'File item opened a chooser');
  await chooser.setFiles({name:'resume.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4')});
  assert.equal(await page.evaluate(()=>window.picked),'resume.pdf');
  assert.equal(await page.evaluate(()=>window.dropbox),undefined,'Dropbox never clicked');
 }finally{await browser.close();}
});
