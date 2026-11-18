import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {snapshot,mustTickBox} from '../src/dashboard-worker.mjs';
import {inFormConsentToTick} from '../src/data-consent.mjs';
// Kratos 14919 (submit4jobs / pereless iframe): the privacy box is required only by its red caption, and Continue
// stays disabled (so it is absent from the control list) until the box is ticked.
const STEP=`<form name="myForm" novalidate><label>Email <span>*</span></label><input type="email" name="email.test" required>
<div class="form-group"><label class="css-input css-checkbox"><input type="checkbox" id="gdpr"><span></span> I agree to the
<a href="https://power.pereless.com/privacy/" target="_blank">privacy statement</a>
<small class="text-danger">(In order to create your account and go to the next step, you must agree to the privacy statement.)</small></label></div>
<button type="button" id="go" disabled>Continue</button></form>
<script>gdpr.onchange=()=>{go.disabled=!gdpr.checked}</script>`;
test('Kratos email step: the must-agree privacy box is ticked, which enables Continue',{timeout:60000},async()=>{
 const b=await chromium.launch();try{const p=await b.newPage();
 const url='https://apps3.pereless.com/templates/magnetolive/?cid=85347';
 await p.route(url,r=>r.fulfill({contentType:'text/html',body:STEP}));await p.goto(url);
 const box=(await snapshot(p)).frames.flatMap(f=>f.controls).find(c=>c.type==='checkbox');
 assert.ok(box&&box.inForm);
 assert.equal(inFormConsentToTick(box),true);
 assert.equal(mustTickBox(box),true);// ticked by the worker itself, before any model step
 await p.check('#gdpr');
 assert.ok((await snapshot(p)).frames.flatMap(f=>f.controls).some(c=>/continue/i.test(c.label)));
 // Not in a form, or an opt-in, or with no "must agree": still not ticked.
 assert.equal(inFormConsentToTick({...box,inForm:false}),false);
 assert.equal(inFormConsentToTick({...box,label:'I agree to the privacy statement and to receive job alerts; you must agree to the privacy statement'}),false);
 assert.equal(inFormConsentToTick({...box,label:'I agree to the privacy statement'}),false);
 assert.equal(mustTickBox({...box,label:'I agree to the privacy statement'}),false);
 assert.equal(mustTickBox({...box,value:'true'}),false);
 }finally{await b.close();}
});
