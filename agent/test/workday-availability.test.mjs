import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertWorkdayPostingAvailable,openAvailableWorkdaySignInForm} from '../src/workday-availability.mjs';
import {outcome} from '../src/dashboard-workday.mjs';

const missing="<nav>Sign In</nav><main>The page you are looking for doesn't exist.</main>";
test('Workday removed pages stop before credential fill, including during a form switch',async t=>{
 const root=await mkdtemp(join(tmpdir(),'workday-availability-'));
 let context;
 try {
  context=await chromium.launchPersistentContext(join(root,'profile'),{headless:true,viewport:{width:1280,height:1000},timeout:30000});
  const page=context.pages()[0];
  await t.test('reproduces the saved fill timeout and replaces it with the posting diagnosis',async()=>{
   await page.setContent(missing);
   await assert.rejects(page.locator('[data-automation-id="email"]').fill('fixture@example.test',{timeout:100}),/Timeout 100ms exceeded/);
   await assert.rejects(openAvailableWorkdaySignInForm(page),/Posting unavailable:/);
  });
  await t.test('a delayed missing page after Create Account is also detected',async()=>{
   await page.setContent('<input data-automation-id="email"><input data-automation-id="verifyPassword"><button data-automation-id="signInLink">Sign In</button>');
   await assert.rejects(openAvailableWorkdaySignInForm(page,{tries:1,wait:async()=>page.setContent(missing)}),/Posting unavailable:/);
  });
  await t.test('real sign-in fields are accepted without typing credentials',async()=>{
   await page.setContent('<input data-automation-id="email"><input data-automation-id="password" type="password">');
   assert.equal(await openAvailableWorkdaySignInForm(page),true);
   assert.deepEqual(await page.locator('input').evaluateAll(es=>es.map(e=>e.value)),['','']);
  });
  await t.test('Boeing missing-page shell retires the role even when the heading wraps',async()=>{
   for(const heading of ["The page you are looking for doesn't exist.","The page you are looking for<br>doesn’t exist."]) {
    await page.setContent(`<nav><button>Sign In</button></nav><main><h2>${heading}</h2><button>Search for Jobs</button></main>`);
    let fillAttempted=false;
    await assert.rejects(async()=>{
     try {await openAvailableWorkdaySignInForm(page);}
     catch(error) {
      const result=outcome({status:'blocked',reason:error.message});
      assert.equal(result.status,'skipped');
      assert.equal(result.posting_unavailable,true);
      throw error;
     }
     fillAttempted=true;
    },/Posting unavailable:/);
    assert.equal(fillAttempted,false);
   }
  });
  await t.test('rate limits and incomplete pages are not classified as removed postings',async()=>{
   for(const text of ['Something went wrong. Please refresh the page.','Too many requests (429)','Loading…','Start Your Application']) {
    await page.setContent(`<main>${text}</main>`);
    await assertWorkdayPostingAvailable(page);
   }
  });
 }finally{await context?.close();await rm(root,{recursive:true,force:true});}
});
