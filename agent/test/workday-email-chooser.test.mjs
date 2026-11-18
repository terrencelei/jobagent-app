import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openWorkdayBrowser} from '../src/workday-browser.mjs';
import {openSignInForm} from '../src/workday.mjs';
import {fillWorkdaySignInCredentials,submitWorkdaySignIn} from '../src/workday-auth-form.mjs';

test('Workday email chooser is ready despite earlier hidden auth fields',async()=>{
 const root=await mkdtemp(join(tmpdir(),'workday-email-chooser-'));
 let context;
 try{
  context=await openWorkdayBrowser(chromium,join(root,'profile'),{headless:true,viewport:{width:1280,height:1000}});
  const page=context.pages()[0];
  await page.setContent(`<div hidden><input data-automation-id="email"><input data-automation-id="password"></div>
   <main><h1>Sign In</h1><button onclick="window.sso=true">Sign in with Apple</button><button onclick="window.sso=true">Sign in with Google</button>
   <button data-automation-id="SignInWithEmailButton" onclick="document.querySelector('form').hidden=false;this.hidden=true">Sign in with email</button>
   <form hidden onsubmit="event.preventDefault();window.signed=true"><input data-automation-id="email"><input type="password" data-automation-id="password"><button data-automation-id="signInSubmitButton">Sign In</button></form></main>`);
  assert.equal(await openSignInForm(page,{tries:1,wait:async()=>{}}),true);
  await page.locator('[data-automation-id="SignInWithEmailButton"]').click();
  assert.equal(await openSignInForm(page,{tries:1,wait:async()=>{}}),true);
  const scope=await fillWorkdaySignInCredentials(page,{email:'fixture@example.test',password:'fixture-password'});
  assert.equal(await submitWorkdaySignIn(scope),true);
  assert.equal(await page.evaluate(()=>window.signed),true);
  assert.equal(await page.evaluate(()=>Boolean(window.sso)),false);
  assert.deepEqual(await page.locator('div[hidden] input').evaluateAll(es=>es.map(e=>e.value)),['','']);
 }finally{await context?.close();await rm(root,{recursive:true,force:true});}
});
