import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshot} from '../src/dashboard-worker.mjs';

// Waymo 13548: the frame detached right after the resume upload, between the snapshot read and the
// follow-up label/history annotations, and "Frame was detached" failed the whole run.
test('snapshot survives a frame that detaches after its first read',async()=>{
 let calls=0;
 const frame={evaluate:async()=>{
  if(calls++===0)return {frameIndex:0,url:'https://example.com/apply',text:'Apply',controls:[{id:'c1',type:'text',label:'First name',historySection:'Work experience'}]};
  throw new Error('frame.evaluate: Frame was detached');
 }};
 const page={frames:()=>[frame],url:()=>'https://example.com/apply'};
 const snap=await snapshot(page);
 assert.equal(snap.frames.length,1);
 assert.equal(snap.frames[0].controls[0].label,'First name');
});
