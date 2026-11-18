import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForPageAdvance} from '../src/captcha-handoff.mjs';

const noSleep=async()=>{};

test('continues by itself once he is past the sign-in page and the address stays changed',async()=>{
 const urls=['https://login.example/u/login#a','https://login.example/u/login#b','https://login.example/captcha','https://login.example/u/login',...Array(10).fill('https://careers.example/apply')];
 let i=0,polls=0;
 const out=await waitForPageAdvance({url:()=>urls[Math.min(i,urls.length-1)],sleep:async()=>{i++;polls++;},stablePolls:3});
 assert.equal(out,'advanced');
 assert.ok(polls>=6,'a brief detour back to the same page restarts the count');
});

test('a hash-only change is not leaving the page; Resume still ends the wait',async()=>{
 let n=0;
 const out=await waitForPageAdvance({url:()=>`https://login.example/u/login#${n}`,command:async()=>++n>5?{action:'resume'}:null,sleep:noSleep});
 assert.equal(out,'resume');
});

test('a closed window ends the wait with an error',async()=>{
 await assert.rejects(waitForPageAdvance({url:()=>'https://login.example/',closed:()=>true,sleep:noSleep}),/window was closed/);
});

test('gives up after the time limit so the run can park instead of holding a slot',async()=>{
 let t=0;
 assert.equal(await waitForPageAdvance({url:()=>'https://login.example/',sleep:async()=>{t+=500;},now:()=>t,timeoutMs:2000}),'timeout');
});
