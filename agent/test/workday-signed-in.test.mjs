import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {workdaySignedIn} from '../src/workday-auth-form.mjs';

const email='fixture@example.test';
const bar=inner=>`<header><div data-automation-id="utilityButtonBar">${inner}</div></header><h2>My Information</h2>`;

test('a Workday header showing Settings and the account email counts as signed in (Firefly 12692)',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(bar(`<button>Settings</button> | <button>${email.toUpperCase()}</button>`));
  assert.equal(await workdaySignedIn(page,email),true);
  await page.setContent(bar('<button data-automation-id="utilityButtonSignIn">Sign In</button>'));
  assert.equal(await workdaySignedIn(page,email),false);
  await page.setContent(bar('<button>Settings</button> | <button>someone-else@example.test</button>'));
  assert.equal(await workdaySignedIn(page,email),false);
  await page.setContent(bar(`<button data-automation-id="utilityButtonSignIn">Sign In</button><span>${email}</span>`));
  assert.equal(await workdaySignedIn(page,email),false);
  await page.setContent('<button data-automation-id="accountSettingsButton">Account</button>');
  assert.equal(await workdaySignedIn(page,email),true);
 }finally{await browser.close();}
});
