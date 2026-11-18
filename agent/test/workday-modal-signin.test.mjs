import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {openSignInForm} from '../src/workday.mjs';
import {fillWorkdaySignInCredentials,submitWorkdaySignIn} from '../src/workday-auth-form.mjs';

// ABB's retained Create Account background remains CSS-visible beneath the
// Sign In dialog, so global first()/verifyPassword queries target the wrong form.
const background=`<main><h1>Create Account</h1><input data-automation-id="email"><input data-automation-id="password" type="password"><input data-automation-id="verifyPassword" type="password"><button data-automation-id="createAccountSubmitButton" onclick="window.created=true">Create Account</button></main>`;
const dialog=`<div role="dialog" aria-modal="true"><h2>Sign In</h2><input data-automation-id="email"><input data-automation-id="password" type="password"><button data-automation-id="signInSubmitButton" onclick="window.signed=true">Sign In</button></div>`;
test('Workday modal sign-in ignores mounted background registration and fills only scoped fields',async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage();
  await page.setContent(`${background}<button data-automation-id="utilityButtonSignIn">Sign In</button><script>document.querySelector('[data-automation-id=utilityButtonSignIn]').onclick=()=>document.body.insertAdjacentHTML('beforeend',${JSON.stringify(dialog)});</script>`);
  assert.equal(await openSignInForm(page,{tries:2,wait:async()=>{}}),true);
  const scope=await fillWorkdaySignInCredentials(page,{email:'fixture@example.test',password:'fixture-password'});
  assert.deepEqual(await page.locator('main input').evaluateAll(es=>es.map(e=>e.value)),['','','']);
  assert.deepEqual(await page.locator('[role=dialog] input').evaluateAll(es=>es.map(e=>e.value)),['fixture@example.test','fixture-password']);
  assert.equal(await submitWorkdaySignIn(scope),true);
  assert.equal(await page.evaluate(()=>window.signed),true);
  assert.equal(await page.evaluate(()=>Boolean(window.created)),false);
 }finally{await browser.close();}
});
test('Ambiguous visible sign-in dialogs never receive credentials',async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage();await page.setContent(`${background}${dialog}${dialog}`);
  await assert.rejects(fillWorkdaySignInCredentials(page,{email:'fixture@example.test',password:'fixture-password'}),/ambiguous/);
  assert.ok((await page.locator('input').evaluateAll(es=>es.map(e=>e.value))).every(v=>v===''));
 }finally{await browser.close();}
});
