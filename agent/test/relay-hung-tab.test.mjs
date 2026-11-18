import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {closeHungTabs,freePort} from '../src/human-chrome.mjs';

// Saronic 2784 (lesson 366): a frozen tab left in the relay Chrome by an earlier run made every later
// connectOverCDP time out. closeHungTabs closes only the unresponsive page.
test('closeHungTabs closes a frozen leftover tab and keeps responsive ones', async () => {
 const port=await freePort();
 const owner=await chromium.launch({headless:true,args:[`--remote-debugging-port=${port}`]});
 const endpoint=`http://127.0.0.1:${port}`;
 try{
  const ctx=await owner.newContext();
  const live=await ctx.newPage();await live.goto('about:blank#other-run');
  const mine=await ctx.newPage();await mine.goto('about:blank#this-run');
  const frozen=await ctx.newPage();await frozen.goto('about:blank#stale');
  frozen.evaluate('setTimeout(()=>{for(;;){}},0)').catch(()=>{});
  await new Promise(r=>setTimeout(r,300));
  const closed=await closeHungTabs(endpoint,{keep:'this-run',probeMs:1500});
  assert.deepEqual(closed,['about:blank#stale']);
  const pages=async()=>(await (await fetch(`${endpoint}/json/list`)).json()).filter(t=>t.type==='page').map(t=>t.url);
  let urls=await pages();for(let i=0;i<40&&urls.includes('about:blank#stale');i++){await new Promise(r=>setTimeout(r,250));urls=await pages();}
  assert.ok(urls.includes('about:blank#other-run'));assert.ok(urls.includes('about:blank#this-run'));
  assert.ok(!urls.includes('about:blank#stale'));
  const attached=await chromium.connectOverCDP(endpoint,{timeout:10000});await attached.close();
 }finally{await owner.close();}
});

// Hermeus 13988 (lesson 465): a concurrent run's tab that is merely busy for a few seconds missed the single
// short probe and was closed under it. A second, longer probe spares it.
test('closeHungTabs spares a tab that is only briefly busy', async () => {
 const port=await freePort();
 const owner=await chromium.launch({headless:true,args:[`--remote-debugging-port=${port}`]});
 const endpoint=`http://127.0.0.1:${port}`;
 try{
  const ctx=await owner.newContext();
  const busy=await ctx.newPage();await busy.goto('about:blank#busy-run');
  busy.evaluate('setTimeout(()=>{const t=Date.now();while(Date.now()-t<2500){}},0)').catch(()=>{});
  await new Promise(r=>setTimeout(r,200));
  const closed=await closeHungTabs(endpoint,{keep:'this-run',probeMs:1000});
  assert.deepEqual(closed,[]);
 }finally{await owner.close();}
});
