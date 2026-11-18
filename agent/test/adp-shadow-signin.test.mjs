import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {snapshot} from '../src/dashboard-worker.mjs';
import {declineOptionalCookies} from '../src/required-contacts.mjs';

// Toyota Automated Logistics 12808 (ADP myjobs): the sign-in email <input> lives in the <sdf-input> open shadow
// root, so the snapshot never listed it and the step agent clicked Continue with the box empty. The OneTrust
// banner over it offered only "Deny" / "Agree and proceed", which the cookie decline did not recognize.
const page_=`<div id="onetrust-banner-sdk"><p>Our site uses cookies and similar technologies to remember your visit.</p>
 <button id="prefs">Set your preferences</button><button id="deny" onclick="this.closest('div').remove()">Deny</button><button>Agree and proceed</button></div>
 <h1>Welcome!</h1><sdf-input id="email"></sdf-input><sdf-button><button>Continue</button></sdf-button>
 <script>customElements.define('sdf-input',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open'}).innerHTML='<label for="i">Email Address</label><input id="i" type="email">';}});</script>`;

test('ADP sign-in: shadow-root email input is listed and fillable; OneTrust Deny declines cookies',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.route('https://myjobs.adp.com/example/auth',r=>r.fulfill({contentType:'text/html',body:page_}));
  await page.goto('https://myjobs.adp.com/example/auth');
  assert.equal(await declineOptionalCookies(page),true);
  assert.equal(await page.locator('#onetrust-banner-sdk').count(),0);
  const snap=await snapshot(page);
  const email=snap.frames.flatMap(f=>f.controls).find(c=>c.label==='Email Address');
  assert.ok(email,'the shadow-root email input appears in the snapshot');
  assert.equal(email.type,'email');
  await page.locator(`[data-ja-control="${email.id}"]`).fill('applicant@example.com');
  assert.equal(await page.evaluate(()=>document.querySelector('sdf-input').shadowRoot.querySelector('input').value),'applicant@example.com');
  await snapshot(page);
  assert.equal(await page.evaluate(()=>document.querySelector('sdf-input').shadowRoot.querySelector('[data-ja-control]')?.getAttribute('data-ja-control')),email.id,'re-snapshot retags shadow controls consistently');
 }finally{await browser.close();}
});
