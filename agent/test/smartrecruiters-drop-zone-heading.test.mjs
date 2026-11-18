import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {uploadZoneHeading,genericResumeDrop} from '../src/generic-resume-drop.mjs';

// Intuitive 12316 (SmartRecruiters one-click): both drop zones are web components whose section title is a sibling
// of the shadow host (a <spl-typography-title>, not an <h2>), so the title is read by climbing out of the shadow root,
// and the component name (<oc-resume-upload>, <oc-apply-with-resume>) is appended for the "Easy Apply" parser zone.
test('the title above a shadow-DOM drop zone is read across the shadow boundary',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<main>
   <div class="form-section"><spl-typography-title>Easy Apply</spl-typography-title><spl-typography-body>Choose an option to autocomplete your application.</spl-typography-body>
    <oc-apply-with-resume><spl-form-field><spl-dropzone id="top"></spl-dropzone></spl-form-field></oc-apply-with-resume></div>
   <section><h2>Your Profiles</h2><input id="site"></section>
   <oc-resume-upload><div class="form-section"><spl-typography-title>Resume</spl-typography-title><spl-form-field><spl-dropzone id="cv"></spl-dropzone></spl-form-field></div></oc-resume-upload>
   <oc-cover-letter-upload><div class="form-section"><spl-typography-title>Cover letter</spl-typography-title><spl-form-field><spl-dropzone id="cover"></spl-dropzone></spl-form-field></div></oc-cover-letter-upload>
  </main>`);
  await page.evaluate(()=>{for(const id of ['top','cv','cover']){const root=document.getElementById(id).attachShadow({mode:'open'});root.innerHTML=`<div class="c-spl-dropzone"><label>Choose a file or drop it here</label><input id="${id}-input" type="file"></div>`;}});
  const sr='https://jobs.smartrecruiters.com/oneclick-ui/company/X/publication/1';
  const zone=id=>({id,label:'Choose a file or drop it here',type:'file'});const zones=[zone('f0c0'),zone('f0c15'),zone('f0c16')];
  const cv=await uploadZoneHeading(page.locator('#cv-input'));
  assert.equal(cv,'Resume · oc resume upload');
  assert.equal(genericResumeDrop(zones[1],sr,zones,false,cv),true);
  const top=await uploadZoneHeading(page.locator('#top-input'));
  assert.equal(top,'Easy Apply · oc apply with resume');
  assert.equal(genericResumeDrop(zones[0],sr,zones,false,top),true);
  const cover=await uploadZoneHeading(page.locator('#cover-input'));
  assert.equal(cover,'Cover letter · oc cover letter upload');
  assert.equal(genericResumeDrop(zones[2],sr,zones,false,cover),false);
  assert.equal(await uploadZoneHeading(page.locator('#site')),'Your Profiles');
 }finally{await browser.close();}
});
