import test from 'node:test';
import assert from 'node:assert/strict';
import {timed} from '../src/slow-step.mjs';

test('names only work slower than the limit and keeps the result',async()=>{
 const lines=[];let clock=0;
 const now=()=>clock;
 assert.equal(await timed('listbox a',async()=>{clock+=500;return 1;},{log:l=>lines.push(l),now}),1);
 assert.equal(await timed(async()=>'prompt b',async()=>{clock+=4200;return 2;},{log:l=>lines.push(l),now}),2);
 assert.deepEqual(lines,['  slow: prompt b took 4.2s']);
});

test('a failing control is still timed and its error kept',async()=>{
 const lines=[];let clock=0;
 await assert.rejects(timed('listbox c',async()=>{clock+=9000;throw new Error('menu');},{log:l=>lines.push(l),now:()=>clock}),/menu/);
 assert.deepEqual(lines,['  slow: listbox c took 9.0s']);
});
