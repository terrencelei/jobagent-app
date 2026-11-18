import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openAvailableWorkdaySignInForm} from '../src/workday-availability.mjs';
import {openWorkdayBrowser} from '../src/workday-browser.mjs';

// Saved ABB failure: the start page has no auth fields, just a header Sign In.
// No employer requests or saved credentials are needed to exercise this transition.
test('Workday opens header sign-in from the application start screen',async t=>{
 const root=await mkdtemp(join(tmpdir(),'workday-start-signin-'));
 let context;
 try {
  context=await openWorkdayBrowser(chromium,join(root,'profile'),{headless:true,viewport:{width:1280,height:1000}});
  const page=context.pages()[0];
  const start=header=>`<header>${header}</header><main><h1>Start Your Application</h1><button disabled>Apply Manually</button><button disabled>Autofill with Resume</button><button onclick="window.sso=true">Apply With LinkedIn</button></main><script>
   window.opens=0;
   document.querySelector('header').onclick=()=>{window.opens++;setTimeout(()=>{document.querySelector('main').innerHTML='<input data-automation-id="email"><input data-automation-id="password" type="password">';},20);};
  </script>`;
  for(const header of ['<button data-automation-id="utilityButtonSignIn">Sign In</button>','<a href="#">Sign In</a>','<button data-automation-id="utilityButtonSignIn">Se connecter</button>']) {
   await t.test(header,async()=>{
    await page.setContent(start(header));
    assert.equal(await page.locator('input').count(),0);
    assert.equal(await openAvailableWorkdaySignInForm(page,{tries:3,wait:()=>page.waitForTimeout(50)}),true);
    assert.equal(await page.evaluate(()=>window.opens),1);
    assert.equal(await page.evaluate(()=>Boolean(window.sso)),false);
    assert.deepEqual(await page.locator('input').evaluateAll(es=>es.map(e=>e.value)),['','']);
   });
  }
  await t.test('a header that fails to open fields stays blocked',async()=>{
   await page.setContent('<header><button data-automation-id="utilityButtonSignIn">Sign In</button></header><h1>Start Your Application</h1>');
   assert.equal(await openAvailableWorkdaySignInForm(page,{tries:2,wait:async()=>{}}),false);
  });
 } finally {await context?.close();await rm(root,{recursive:true,force:true});}
});
