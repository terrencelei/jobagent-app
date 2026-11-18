import test from 'node:test';
import assert from 'node:assert/strict';
import {submitControlDisabled} from '../src/dashboard-worker.mjs';

const fake=({disabled=false,aria=null,throws=false}={})=>({
  isDisabled:async()=>{if(throws)throw new Error('detached');return disabled;},
  getAttribute:async name=>{if(throws)throw new Error('detached');return name==='aria-disabled'?aria:null;},
});

test('a greyed-out Apply is not clicked as a submission (AtmosZero 12640, lesson 311)',async()=>{
  assert.equal(await submitControlDisabled(fake({disabled:true})),true);
  assert.equal(await submitControlDisabled(fake({aria:'true'})),true);
});

test('an enabled or unreadable Submit proceeds as before',async()=>{
  assert.equal(await submitControlDisabled(fake()),false);
  assert.equal(await submitControlDisabled(fake({aria:'false'})),false);
  assert.equal(await submitControlDisabled(fake({throws:true})),false);
});
