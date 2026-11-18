import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {clickPastCookieBanner} from '../src/dashboard-worker.mjs';

test('a cookie bar covering a button does not block the click, and no cookie choice is made (IBM 11946)',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<button id="go" onclick="this.textContent='clicked'">Proceed</button>
   <div id="consent_blackbar" style="position:fixed;inset:0;background:#0008"><span>About cookies</span><button id="accept" onclick="window.accepted=true">Accept All</button></div>`);
  await clickPastCookieBanner(page.locator('#go'),{timeout:1500});
  assert.equal(await page.locator('#go').textContent(),'clicked');
  assert.equal(await page.evaluate(()=>window.accepted),undefined);
  // Any other overlay is still an error, not something to click through.
  await page.setContent(`<button id="go">Proceed</button><div id="modal" style="position:fixed;inset:0;background:#0008"></div>`);
  await assert.rejects(clickPastCookieBanner(page.locator('#go'),{timeout:1500}));
 }finally{await browser.close();}
});

test('declineOptionalCookies returns false instead of throwing when the banner cannot be clicked (Karman 12729)',async()=>{
 const {declineOptionalCookies}=await import('../src/required-contacts.mjs');
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<div id="b"><p>We use cookies</p><button>Deny</button><button>Agree and proceed</button></div>
   <div style="position:fixed;inset:0;background:#0008"></div>`);
  assert.equal(await declineOptionalCookies(page),false);
 }finally{await browser.close();}
});

test('a Cookie consent modal over a declaration label does not stop the checkbox tick, and no cookie choice is made (Waymo 13548)',async()=>{
 const {setCheckedControl}=await import('../src/dashboard-worker.mjs');
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<form><input type="checkbox" id="form_declaration_7_0_6" style="display:none" required>
   <label for="form_declaration_7_0_6" class="form-template-field-label declaration">I certify the information is true</label></form>
   <div role="dialog" aria-modal="true" aria-label="Cookie consent" class="consent-modal modal show" style="position:fixed;inset:0;background:#0008">
   <button onclick="window.accepted=true">Accept all</button></div>`);
  await setCheckedControl(page.mainFrame(),page.locator('#form_declaration_7_0_6'),true);
  assert.equal(await page.locator('#form_declaration_7_0_6').isChecked(),true);
  assert.equal(await page.evaluate(()=>window.accepted),undefined);
 }finally{await browser.close();}
});
