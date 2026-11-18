import test from 'node:test';
import assert from 'node:assert/strict';
import {stuckStep,leanStep} from '../src/step-mode.mjs';

test('a run is stuck after two refusals or one action three times in its last eight steps',()=>{
  assert.equal(stuckStep([]),false);
  assert.equal(stuckStep([{action:'rejected',control:'x'}]),false);
  assert.equal(stuckStep([{action:'rejected',control:'x'},{action:'fill',control:'a'},{action:'rejected',control:'y'}]),true);
  assert.equal(stuckStep([{action:'click',control:'Next'},{action:'click',control:'Next'},{action:'click',control:'Next'}]),true);
  const old=[{action:'rejected',control:'x'},{action:'rejected',control:'y'},...Array.from({length:8},(_,i)=>({action:'fill',control:`f${i}`}))];
  assert.equal(stuckStep(old),false,'only the last eight steps count');
});

test('lean unless turned off or stuck',()=>{
  assert.equal(leanStep([],{enabled:true}),true);
  assert.equal(leanStep([],{enabled:false}),false);
  assert.equal(leanStep([{action:'rejected',control:'x'},{action:'rejected',control:'y'}],{enabled:true}),false);
});
