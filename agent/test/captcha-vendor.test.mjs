import test from 'node:test';
import assert from 'node:assert/strict';
import {vendorSolver,vendorDetect,vendorStealth} from '../src/captcha-vendor.mjs';
import {captchaPending,solveCaptchaPackage} from '../src/captcha-handoff.mjs';

test('the supplied package loads as CommonJS inside the ESM agent', ()=>{
 const s=vendorSolver();
 for(const fn of ['solveIfPresent','setContext','clearChallenge','identify'])assert.equal(typeof s[fn],'function');
 assert.equal(typeof vendorDetect().detect,'function');
 assert.ok(vendorStealth().STEALTH_ARGS.includes('--disable-blink-features=AutomationControlled'));
});

test('captchaPending counts a challenge only the package detector sees', async ()=>{
 const page={evaluate:async()=>false};
 assert.equal(await captchaPending(page,{challengeVisible:async()=>false,detect:async()=>({live:true})}),true);
 assert.equal(await captchaPending(page,{challengeVisible:async()=>false,detect:async()=>({live:false})}),false);
});

test('a package failure falls back to the ESM port instead of skipping tier 0', async ()=>{
 const logs=[];
 const page={url:()=>{throw new Error('boom');},frames:()=>[],mainFrame:()=>null,evaluate:async()=>null,on(){},off(){}};
 const r=await solveCaptchaPackage(page,{log:m=>logs.push(m)}).catch(e=>({error:e.message}));
 assert.ok(logs.some(m=>/Package CAPTCHA solver failed/.test(m)));
 assert.ok(r);
});

test('in the relay Chrome the package extensions get their turn and no hand-off window is offered', async ()=>{
 const {resolveChallengeFree}=await import('../src/captcha-handoff.mjs');
 const page={frames:()=>[]};let visible=true;
 const none=async()=>({solved:false,type:'none'});
 const ok=await resolveChallengeFree(page,{challengeVisible:async()=>visible,headless:true,relay:true,local:none,
  extensions:async()=>{visible=false;return {solved:true,by:'token'};},human:async()=>{throw new Error('no hand-off');}});
 assert.deepEqual(ok,{completed:true,by:'relay-extension'});
 visible=true;
 const miss=await resolveChallengeFree(page,{challengeVisible:async()=>true,headless:true,relay:true,local:none,extensions:async()=>({solved:false,by:'timeout'}),human:async()=>{throw new Error('no hand-off');}});
 assert.equal(miss.completed,false);assert.match(miss.reason,/relay Chrome extensions: timeout.*relay Chrome is hidden/);
});
