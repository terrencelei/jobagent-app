import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {clickAuthControl,consentOverlayBlocked} from '../src/dashboard-worker.mjs';

// Siemens 6654 (Avature jobs.siemens.com): email and password were filled, then the Log in click timed out
// because Usercentrics' "We value your privacy" modal (#usercentrics-root, a shadow host with a full-page
// backdrop) intercepted pointer events. The sign-in click now falls back to a DOM click on the button itself,
// submitting the login form without accepting or rejecting any cookies.
test('a Usercentrics cookie modal over Log in does not block the sign-in click, and no cookie choice is made (Siemens 6654)',async()=>{
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();page.setDefaultTimeout(1500);
  await page.route('https://jobs.example.com/en_US/externaljobs/Login',r=>r.request().method()==='POST'?r.fulfill({contentType:'text/html',body:'<h1>Signed in</h1>'}):r.fulfill({contentType:'text/html',body:`<form method="post" action="/en_US/externaljobs/Login">
   <label>Email <input name="email" value="someone@example.edu"></label><label>Password <input name="password" type="password" value="x"></label>
   <button id="login" name="login" type="submit" value="Log in" data-component="login-button">Log in</button></form>
   <div id="usercentrics-root"></div>
   <script>const root=document.getElementById('usercentrics-root').attachShadow({mode:'open'});root.innerHTML='<div style="position:fixed;inset:0;background:#0008"><div role="dialog"><h2>We value your privacy</h2><p>By clicking "Accept All Cookies", you agree to the storing of cookies on your device.</p><button onclick="window.cookieChoice=\\'reject\\'">Reject Cookies</button><button onclick="window.cookieChoice=\\'accept\\'">Accept All Cookies</button></div></div>';</script>`}));
  await page.goto('https://jobs.example.com/en_US/externaljobs/Login');
  await clickAuthControl(page,page.locator('#login'),{loadTimeout:8000});
  assert.equal(await page.locator('h1').textContent(),'Signed in');
  assert.equal(await page.evaluate(()=>window.cookieChoice),undefined);
  // Any other overlay is still an error, not something to click through.
  await page.setContent(`<form><button id="login" type="submit">Log in</button></form><div id="modal" style="position:fixed;inset:0;background:#0008"></div>`);
  await assert.rejects(clickAuthControl(page,page.locator('#login')),/intercepts pointer events/);
 }finally{await browser.close();}
});

test('consentOverlayBlocked recognizes consent-manager hosts only when they intercept the click',()=>{
 assert.equal(consentOverlayBlocked(new Error('locator.click: Timeout 10000ms exceeded.\n  - <div id="usercentrics-root" data-created-at="1792799688596"></div> intercepts pointer events')),true);
 assert.equal(consentOverlayBlocked(new Error('locator.click: Timeout 10000ms exceeded.\n  - <div id="consent_blackbar"></div> intercepts pointer events')),true);
 assert.equal(consentOverlayBlocked(new Error('locator.click: Timeout 10000ms exceeded.\n  - <div id="modal"></div> intercepts pointer events')),false);
 assert.equal(consentOverlayBlocked(new Error('usercentrics cookie page did not load')),false);
 assert.equal(consentOverlayBlocked(undefined),false);
});
