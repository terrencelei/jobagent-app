import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openWorkdayApplicationPage} from '../src/workday-opening.mjs';
import {startLiveView} from '../src/live-view.mjs';

test('initial Workday opening recovers a disconnected browser using only a local fixture',async t=>{
 const requests=[];
 const server=createServer((req,res)=>{
  requests.push({method:req.method,url:req.url});
  res.writeHead(req.url==='/limited'?429:200,{'content-type':'text/html'});
  res.end(req.url==='/limited'?'Something went wrong. Please refresh the page.':'<h1>Start Your Application</h1>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const root=await mkdtemp(join(tmpdir(),'workday-opening-'));
 let context,live;
 try {
  // Match the dashboard worker: a persistent Chromium profile and live CDP
  // screencast, without reading any applicant profile, cookies or credentials.
  context=await chromium.launchPersistentContext(join(root,'profile'),{headless:true,viewport:{width:1280,height:1000},timeout:30000});
  const page=context.pages()[0]??await context.newPage();
  live=await startLiveView(context,page,join(root,'screenshot.jpg'));
  const url=`http://127.0.0.1:${server.address().port}/apply`;
  await context.setOffline(true);
  await assert.rejects(page.goto(url),/net::ERR_INTERNET_DISCONNECTED/);
  await t.test('recovers once connectivity returns, without any form actions',async()=>{
   const waits=[],events=[];
   const response=await openWorkdayApplicationPage(page,url,{onEvent:event=>events.push(event),wait:async ms=>{waits.push(ms);await context.setOffline(false);}});
   assert.equal(response.status(),200);
   assert.equal(await page.locator('h1').innerText(),'Start Your Application');
   assert.deepEqual(waits,[1000]);assert.equal(events.length,2);
   assert.match(events[1],/initial page loaded after the browser disconnect/);
   assert.equal(requests.filter(r=>r.url==='/apply').length,1);
   assert.ok(requests.every(r=>r.method==='GET'));
  });
  await t.test('persistent disconnect stops after two retries',async()=>{
   await context.setOffline(true);
   const waits=[],events=[];
   await assert.rejects(openWorkdayApplicationPage(page,url,{onEvent:event=>events.push(event),wait:async ms=>waits.push(ms)}),/net::ERR_INTERNET_DISCONNECTED/);
   assert.deepEqual(waits,[1000,3000]);
   assert.equal(events.length,2);
   assert.ok(events.every(event=>!event.includes('resuming preparation')));
   await context.setOffline(false);
  });
  await t.test('connectivity returning only after the second wait uses the same bounded budget',async()=>{
   await context.setOffline(true);
   const waits=[],events=[],before=requests.filter(r=>r.url==='/apply').length;
   const response=await openWorkdayApplicationPage(page,url,{
    onEvent:event=>events.push(event),wait:async ms=>{waits.push(ms);if(waits.length===2)await context.setOffline(false);},
   });
   assert.equal(response.status(),200);
   assert.deepEqual(waits,[1000,3000]);
   assert.equal(requests.filter(r=>r.url==='/apply').length,before+1);
   assert.equal(events.length,3);
   assert.match(events[2],/resuming preparation/);
  });
  await t.test('a transport disconnect recovers while the browser still reports online',async()=>{
   assert.equal(await page.evaluate(()=>navigator.onLine),true);
   let attempts=0;
   const waits=[],events=[],before=requests.filter(r=>r.url==='/apply').length;
   const interrupt=async route=>{
    assert.equal(route.request().method(),'GET');
    if(++attempts<=2)await route.abort('internetdisconnected');else await route.continue();
   };
   await context.route('**/apply',interrupt);
   try {
    // Use the worker's actual pauses: Chromium must settle its error page
    // before another navigation begins after a transport abort.
    const response=await openWorkdayApplicationPage(page,url,{onEvent:event=>events.push(event),wait:async ms=>{waits.push(ms);await page.waitForTimeout(ms);}});
    assert.equal(response.status(),200);
    assert.equal(await page.evaluate(()=>navigator.onLine),true);
    assert.equal(attempts,3);
    assert.deepEqual(waits,[1000,3000]);
    assert.equal(requests.filter(r=>r.url==='/apply').length,before+1);
    assert.ok(requests.every(r=>r.method==='GET'));
    assert.match(events.at(-1),/resuming preparation/);
   }finally{await context.unroute('**/apply',interrupt);}
  });
  await t.test('employer error and HTTP 429 are returned without retry',async()=>{
   const before=requests.length;
   const response=await openWorkdayApplicationPage(page,url.replace('/apply','/limited'),{wait:async()=>assert.fail('must not retry a delivered error page')});
   assert.equal(response.status(),429);
   assert.match(await page.locator('body').innerText(),/Something went wrong/);
   assert.equal(requests.length,before+1);
  });
  await t.test('a rate limit after connectivity returns does not report resumed preparation',async()=>{
   await context.setOffline(true);
   const events=[],before=requests.length;
   const response=await openWorkdayApplicationPage(page,url.replace('/apply','/limited'),{
    onEvent:event=>events.push(event),wait:async()=>context.setOffline(false),
   });
   assert.equal(response.status(),429);
   assert.equal(requests.length,before+1);
   assert.equal(events.length,1);
   assert.ok(events.every(event=>!event.includes('resuming preparation')));
  });
 }finally {
  await live?.stop();
  await context?.close();
  await new Promise(resolve=>server.close(resolve));
  await rm(root,{recursive:true,force:true});
 }
});

test('a network change during disconnect recovery shares the original retry budget',async()=>{
 const waits=[];
 let calls=0;
 const response={ok:()=>true};
 const page={goto:async()=>{
  calls++;
  if(calls===1)throw Error('page.goto: net::ERR_INTERNET_DISCONNECTED');
  if(calls===2)throw Error('page.goto: net::ERR_NETWORK_CHANGED');
  return response;
 }};
 assert.equal(await openWorkdayApplicationPage(page,'http://fixture.invalid/apply',{wait:async ms=>waits.push(ms)}),response);
 assert.equal(calls,3);
 assert.deepEqual(waits,[1000,3000]);
 calls=0;
 await assert.rejects(openWorkdayApplicationPage({goto:async()=>{calls++;throw Error('page.goto: net::ERR_NETWORK_CHANGED');}},'http://fixture.invalid/apply',{wait:async()=>{}}),/ERR_NETWORK_CHANGED/);
 assert.equal(calls,3);
});

test('other navigation failures are never retried',async()=>{
 for(const code of ['ERR_NAME_NOT_RESOLVED','ERR_CONNECTION_REFUSED','ERR_ABORTED','Timeout 30000ms exceeded']) {
  let calls=0;
  const error=Error(`page.goto: net::${code}`);
  await assert.rejects(openWorkdayApplicationPage({goto:async()=>{calls++;throw error;}},'http://fixture.invalid/apply',{wait:async()=>assert.fail('unexpected retry')}),e=>e===error);
  assert.equal(calls,1);
 }
});
