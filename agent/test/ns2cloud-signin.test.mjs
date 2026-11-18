import test from 'node:test';import assert from 'node:assert/strict';
import {passwordAllowedOn} from '../src/accounts.mjs';
// ULA 8610: jobs.ulalaunch.com's Apply opens SAP NS2 SuccessFactors (career-hcm20.ns2cloud.com).
test('SAP NS2 SuccessFactors sign-in is a known hiring platform',()=>{
 const job='https://jobs.ulalaunch.com/job/Pueblo-Systems-Test-Engineer-1-CO-81001/1436247500/';
 assert.equal(passwordAllowedOn('https://career-hcm20.ns2cloud.com/careers?company=ULAHCM20',job),true);
 assert.equal(passwordAllowedOn('https://ns2cloud.com.evil.example/login',job),false);
 assert.equal(passwordAllowedOn('http://career-hcm20.ns2cloud.com/careers',job),false);
});
