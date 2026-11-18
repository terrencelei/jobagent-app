import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertWorkdayPostingAvailable,openAvailableWorkdaySignInForm} from '../src/workday-availability.mjs';
import {outcome} from '../src/dashboard-workday.mjs';

const outage=`<header>Workday</header><main>
 <h1>Workday is currently unavailable.</h1>
 <p>We are experiencing a service interruption.</p>
 <p>Your service will be restored as quickly as possible.</p>
 <p>Otherwise, please check back later.</p></main>`;

test('Workday service interruption stops authentication and preserves queue cooldown',async t=>{
 const root=await mkdtemp(join(tmpdir(),'workday-outage-'));
 let context;
 try {
  context=await chromium.launchPersistentContext(join(root,'profile'),{
   headless:true,viewport:{width:1280,height:1000},timeout:30000,
  });
  const page=context.pages()[0];
  await t.test('saved outage shell is diagnosed before waiting for missing sign-in controls',async()=>{
   await page.setContent(outage);
   let authWaits=0;
   await assert.rejects(openAvailableWorkdaySignInForm(page,{tries:1,wait:async()=>authWaits++}),error=>{
    assert.match(error.message,/^Site unavailable:/);
    const result=outcome({status:'blocked',reason:error.message});
    assert.equal(result.status,'blocked');
    assert.match(result.message,/^Site unavailable:/);
    assert.equal(result.posting_unavailable,undefined);
    return true;
   });
   assert.equal(authWaits,0);
   assert.equal(await page.locator('input').count(),0);
  });
  await t.test('service interruption arriving during a sign-in switch also stops preparation',async()=>{
   await page.setContent('<input data-automation-id="email"><input data-automation-id="verifyPassword"><button data-automation-id="signInLink">Sign In</button>');
   await assert.rejects(openAvailableWorkdaySignInForm(page,{tries:1,wait:async()=>page.setContent(outage)}),/^Error: Site unavailable:/);
  });
  await t.test('unavailable wording in a job description is not an outage',async()=>{
   await page.setContent('<h1>Service Reliability Engineer</h1><p>Investigate service interruptions and unavailable systems.</p><input data-automation-id="email">');
   await assertWorkdayPostingAvailable(page);
   assert.equal(await openAvailableWorkdaySignInForm(page),true);
  });
 }finally{await context?.close();await rm(root,{recursive:true,force:true});}
});

test('outage classification cannot clear uncertain or accepted submission evidence',()=>{
 const reason='Site unavailable: Workday reports a temporary service interruption.';
 const unknown=outcome({status:'submission_unknown',reason});
 assert.equal(unknown.status,'submission_unknown');
 assert.equal(unknown.submission_attempted,true);
 assert.equal(outcome({status:'submitted',reason}).status,'submitted_pending_receipt');
});
