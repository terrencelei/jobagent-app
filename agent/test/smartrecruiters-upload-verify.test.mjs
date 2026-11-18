import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {resumeAttached} from '../src/dashboard-worker.mjs';

// Intuitive 12315/12316 (SmartRecruiters one-click): the résumé drop zone lives in a shadow root, clears its input after
// parsing, and shows the file name only inside the shadow DOM, which body.innerText does not include.
test('a résumé name shown only inside a shadow root verifies the upload',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent('<div id="host"></div>');
  await page.evaluate(()=>{const root=document.querySelector('#host').attachShadow({mode:'open'});
   root.innerHTML='<div id="zone"><span>Choose a file or drop it here</span><input id="resume" type="file"></div>';
   setTimeout(()=>{root.querySelector('#zone').innerHTML='<input id="resume" type="file"><span>Fixture_Resume.pdf</span><button>Remove</button>';},150);});
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  assert.equal(await resumeAttached(page.mainFrame(),page.locator('#resume'),'Fixture_Resume.pdf',{wait}),true);
  assert.equal(await resumeAttached(page.mainFrame(),page.locator('#resume'),'Different.pdf',{tries:2,wait:async()=>{}}),false);
 }finally{await browser.close();}
});
