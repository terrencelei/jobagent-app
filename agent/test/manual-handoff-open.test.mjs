import test from 'node:test';
import assert from 'node:assert/strict';
import {keepHandoffOpen,handoffChannel} from '../src/dashboard-worker.mjs';

test('an applicant-viewed run stays open after his own Submit but not after a worker click',()=>{
 const request={handoffOnFailure:true};
 assert.equal(keepHandoffOpen({request,submitted:false}),true);
 assert.equal(keepHandoffOpen({request,submitted:true,manualSubmissionAt:'2026-10-20T02:39:09.905Z'}),true);
 assert.equal(keepHandoffOpen({request,submitted:true}),false);
 assert.equal(keepHandoffOpen({request:{},submitted:false}),false);
});

test('installed Chrome is used only for a visible run',()=>{
 assert.equal(handoffChannel(true,{APPLICATION_AGENT_CHANNEL:'chrome'}),undefined);
 assert.equal(handoffChannel(false,{APPLICATION_AGENT_CHANNEL:'chrome'}),'chrome');
 assert.equal(handoffChannel(false,{}),undefined);
});
