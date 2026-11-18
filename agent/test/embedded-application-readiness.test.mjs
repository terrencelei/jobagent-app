import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {waitForEmbeddedApplication} from '../src/embedded-application-readiness.mjs';
import {snapshot} from '../src/dashboard-worker.mjs';

test('Greenhouse placeholder waits through iframe injection and delayed fields',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();
  await context.route('https://job-boards.greenhouse.io/embed/job_app**',route=>route.fulfill({contentType:'text/html',body:'<p>Apply for this job</p><button>Autofill my application</button><script>setTimeout(()=>document.body.insertAdjacentHTML("beforeend",\'<label>First Name<input required></label>\'),250)</script>'}));
  await page.route('http://localhost/fixture',route=>route.fulfill({contentType:'text/html',body:'<body></body>'}));
  await page.goto('http://localhost/fixture');
  await page.setContent('<h1>Manufacturing Engineer</h1><a href="/jobs">Open roles</a><div id="grnhse_app"></div>');
  assert.equal((await snapshot(page)).frames.flatMap(f=>f.controls).some(c=>c.type==='text'),false);
  await page.evaluate(()=>setTimeout(()=>{const iframe=document.createElement('iframe');iframe.src='https://job-boards.greenhouse.io/embed/job_app?for=fixture&token=123';document.querySelector('#grnhse_app').append(iframe);},150));
  assert.equal(await waitForEmbeddedApplication(page,{timeout:3000}),true);
  const readySnapshot=await snapshot(page);
  assert.ok(readySnapshot.frames.flatMap(f=>f.controls).some(c=>c.label==='First Name'),JSON.stringify(readySnapshot));
  await page.setContent('<div id="grnhse_app"></div>');
  assert.equal(await waitForEmbeddedApplication(page,{timeout:100}),false);
  await page.setContent('<h1>Regular page</h1>');
  assert.equal(await waitForEmbeddedApplication(page,{timeout:100}),true);
 }finally{await browser.close();}
});

test('autofill buttons and hidden or disabled fields do not establish embed readiness',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();
  await context.route('https://job-boards.greenhouse.io/embed/job_app**',route=>route.fulfill({contentType:'text/html',body:'<button>Autofill my application</button><input type="file"><input type="hidden"><input disabled><input style="display:none">'}));
  await page.setContent('<div id="grnhse_app"><iframe src="https://job-boards.greenhouse.io/embed/job_app?for=fixture"></iframe></div>');
  assert.equal(await waitForEmbeddedApplication(page,{timeout:250}),false);
  const frame=page.frames().find(f=>f.url().startsWith('https://job-boards.greenhouse.io/'));
  await frame.locator('input[disabled]').evaluate(el=>el.disabled=false);
  assert.equal(await waitForEmbeddedApplication(page,{timeout:500}),true);
 }finally{await browser.close();}
});
