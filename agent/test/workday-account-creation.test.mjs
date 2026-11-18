import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {completeWorkdayAccountCreation,fillWorkdaySignInCredentials,submitWorkdaySignIn} from '../src/workday-auth-form.mjs';

const login=`<h2>Sign In</h2><input data-automation-id="email"><input type="password" data-automation-id="password"><button data-automation-id="signInSubmitButton" onclick="document.body.innerHTML='<button data-automation-id=accountSettingsButton>Account</button><h2>Review</h2>'">Sign In</button>`;

test('registration returning to Sign In continues once with saved credentials, without submitting an application',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  let requests=0;page.on('request',()=>requests++);
  await page.setContent(`<h2>Create Account</h2><input data-automation-id="verifyPassword" type="password"><button id="create">Create Account</button>`);
  await page.locator('#create').evaluate((el,html)=>el.onclick=()=>document.body.innerHTML=html,login);
  await page.locator('#create').click();
  let calls=0;
  const signedIn=async()=>await page.locator('[data-automation-id="accountSettingsButton"]').count()>0;
  const signIn=async()=>{
   calls++;
   const scope=await fillWorkdaySignInCredentials(page,{email:'fixture@example.test',password:'fixture-password'});
   assert.equal(await submitWorkdaySignIn(scope),true);
   return await signedIn()?'ok':'unknown';
  };
  assert.equal(await completeWorkdayAccountCreation(page,{signedIn,signIn}),'ok');
  assert.equal(calls,1);
  assert.equal(await page.getByRole('heading',{name:'Review'}).count(),1);
  assert.equal(requests,0);
 }finally{await browser.close();}
});

test('registration gates and failures do not trigger another sign-in or account creation',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  for(const [html,expected] of [
   [`${login}<input data-automation-id="verifyPassword">`,'unknown'],
   [`${login}<p role="alert">Password does not meet requirements</p>`,'unknown'],
   [`${login}<p>Verify your email</p>`,'needs_verification'],
   [`${login}<p>Account already exists</p>`,'exists'],
   [`${login}<p>Something went wrong. Refresh the page.</p>`,'unknown'],
   [`${login}<p>CAPTCHA</p>`,'unknown'],
   [login+login,'unknown'],
  ]){
   await page.setContent(html);
   assert.equal(await completeWorkdayAccountCreation(page,{signedIn:async()=>false,signIn:async()=>assert.fail('must not sign in')}),expected);
  }
  await page.setContent(login);
  let calls=0;
  assert.equal(await completeWorkdayAccountCreation(page,{signedIn:async()=>false,signIn:async()=>{calls++;return 'rejected';}}),'rejected');
  assert.equal(calls,1,'rejection returns without a retry loop');
 }finally{await browser.close();}
});

// ASML 9067 / KLA 10182: the tenant refused the shared credential, and registering the same
// email bounced silently back to the "Sign in with email" chooser. That is an existing account.
test('a silent return to the sign-in chooser after a rejected shared sign-in means the account exists',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  const chooser=`<h2>Sign In</h2><button data-automation-id="AppleSignInButton">Sign in with Apple</button><button data-automation-id="GoogleSignInButton">Sign in with Google</button><button data-automation-id="SignInWithEmailButton">Sign in with email</button><a>Privacy Notice for Job Applicants</a>`;
  await page.setContent(chooser);
  const signIn=async()=>assert.fail('must not sign in again');
  assert.equal(await completeWorkdayAccountCreation(page,{signedIn:async()=>false,signIn,afterRejectedSignIn:true}),'exists');
  assert.equal(await completeWorkdayAccountCreation(page,{signedIn:async()=>false,signIn}),'unknown','without a prior rejection the chooser stays inconclusive');
  await page.setContent(`${chooser}<p role="alert">Something went wrong</p>`);
  assert.equal(await completeWorkdayAccountCreation(page,{signedIn:async()=>false,signIn,afterRejectedSignIn:true}),'unknown','an alert is never read as an existing account');
  await page.setContent(`${chooser}<input data-automation-id="email"><input type="password" data-automation-id="password">`);
  assert.equal(await completeWorkdayAccountCreation(page,{signedIn:async()=>false,signIn,afterRejectedSignIn:true}),'unknown','a chooser with mounted fields is not the bare chooser');
 }finally{await browser.close();}
});
