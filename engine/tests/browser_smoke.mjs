// Run against the isolated fixture server, never the user's application database.
// PLAYWRIGHT_MODULE may point at an existing Playwright installation.
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture=JSON.parse(readFileSync('/private/tmp/jobagent-browser-fixture-path.json'));
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8877');
 await page.waitForFunction(()=>document.querySelector('#resultCount').textContent.includes('100 of 105'));
 assert.equal(await page.locator('#statActive').innerText(),'105');
 await page.locator('#loadMore').click();
 await page.waitForFunction(()=>document.querySelectorAll('.job-card').length===105);
 await page.locator('#searchInput').fill('Engineer I 10');
 await page.waitForFunction(()=>document.querySelectorAll('.job-card').length===6);
 await page.locator('#searchInput').fill('');
 await page.waitForFunction(()=>document.querySelectorAll('.job-card').length===100);
 await page.locator('#clusterFilter').selectOption('ROBOTICS / MECHATRONICS');
 await page.waitForFunction(()=>document.querySelector('#resultCount').textContent.includes('0 of 0'));
 await page.locator('#clusterFilter').selectOption('');
 await page.waitForFunction(()=>document.querySelectorAll('.job-card').length===100);
 await page.locator('.job-card').first().click();
 await page.locator('#detailModal').waitFor({state:'visible'});
 assert((await page.locator('#modalDesc').innerText()).includes('Required:'));
 await page.locator('#modalNotes').fill('Browser verified notes');
 await page.locator('#btnSave').click();
 await page.locator('#detailModal').waitFor({state:'hidden'});
 await page.locator('[data-tab="saved"]').click();
 await page.waitForFunction(()=>document.querySelectorAll('.job-card').length===2);
 await page.locator('.job-card').filter({hasText:'Mechanical Engineer I 104'}).click();
 await page.locator('#detailModal').waitFor({state:'visible'});
 assert.equal(await page.locator('#modalNotes').inputValue(),'Browser verified notes');
 await page.locator('#btnApplied').click();
 await page.locator('#detailModal').waitFor({state:'hidden'});
 await page.locator('[data-tab="applied"]').click();
 await page.waitForFunction(()=>document.querySelectorAll('.job-card').length===2);
 await page.locator('.job-card').filter({hasText:'Mechanical Engineer I 104'}).click();
 await page.locator('#detailModal').waitFor({state:'visible'});
 assert(await page.locator('#btnApplied').isDisabled());
 await page.locator('#btnInterview').click();
 await page.locator('#detailModal').waitFor({state:'hidden'});
 await page.locator('[data-tab="interview"]').click();
 await page.waitForFunction(()=>document.querySelectorAll('.job-card').length===2);
 await page.locator('.job-card').filter({hasText:'Mechanical Engineer I 104'}).click();
 await page.locator('#detailModal').waitFor({state:'visible'});
 await page.locator('#statusSelect').selectOption('OFFER');await page.locator('#btnStatus').click();
 await page.locator('#detailModal').waitFor({state:'hidden'});
 await page.locator('#moreViews').selectOption('offer');
 await page.waitForFunction(()=>document.querySelectorAll('.job-card').length===2);
 // Every tab remains reachable, including records hidden from the main application queue.
 for(const tab of ['new_today','new_grad','high_match','rejected','withdrawn','closed','ignored']) {
  await Promise.all([page.waitForResponse(r=>r.url().includes('/api/jobs?tab='+tab)),tab === 'needs_review' ? page.locator(`[data-tab="${tab}"]`).click() : page.locator('#moreViews').selectOption(tab)]);
 }
 await page.locator('[data-tab="top_priority"]').click();
 await page.waitForFunction(()=>document.querySelectorAll('.job-card').length===100);
 // A real server error must not be reported as an empty/successful result.
 await page.route('**/api/jobs?*',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({detail:'fixture failure'})}));
 await page.locator('#searchInput').fill('fail');
 await page.locator('#errorState').waitFor({state:'visible'});
 assert((await page.locator('#errorState').innerText()).includes('fixture failure'));
 await page.unroute('**/api/jobs?*');
 await page.locator('#searchInput').fill('');
 await page.waitForFunction(()=>document.querySelectorAll('.job-card').length===100);
 // Test failure path without launching real discovery from the fixture.
 await page.route('**/api/search',r=>r.fulfill({status:500,contentType:'application/json',body:'{"detail":"Scan unavailable"}'}));
 await page.locator('#searchBtn').click();
 await page.waitForFunction(()=>document.querySelector('#uiFeedback')?.textContent.includes('Scan unavailable'));
 assert.equal(await page.locator('#searchBtn').isDisabled(),false);
 await page.screenshot({path:fixture.root+'/live-dashboard.png',fullPage:true});
 const offline=await browser.newPage({viewport:{width:1440,height:1000}});
 offline.on('pageerror',e=>errors.push(e.message));
 await offline.route('http://127.0.0.1:8000/**',r=>r.abort());
 await offline.goto('file://'+fixture.root+'/docs/index.html');
 await offline.waitForFunction(()=>document.querySelector('#resultCount').textContent.includes('100 of 104'));
 assert(await offline.locator('#searchBtn').isDisabled());
 await offline.locator('#moreViews').selectOption('offer');
 await offline.waitForFunction(()=>document.querySelectorAll('.job-card').length===2);
 await offline.locator('.job-card').first().click();
 await offline.locator('#detailModal').waitFor({state:'visible'});
 assert(await offline.locator('#btnStatus').isDisabled());
 assert((await offline.locator('#modalDesc').innerText()).includes('Required:'));
 await offline.keyboard.press('Escape');
 await offline.locator('#detailModal').waitFor({state:'hidden'});
 // When a snapshot connects, it must query each tab, not replace its dataset with Top Priority.
 await offline.unroute('http://127.0.0.1:8000/**');
 await offline.route('http://127.0.0.1:8000/**',async route=>{
  const res=await route.fetch({url:route.request().url().replace(':8000',':8877')});await route.fulfill({response:res});
 });
 await offline.evaluate(()=>sync());
 await offline.locator('[data-tab="saved"]').click();
 await offline.waitForFunction(()=>document.querySelectorAll('.job-card').length===1);
 await offline.locator('.job-card').first().click();
 await offline.locator('#detailModal').waitFor({state:'visible'});
 assert((await offline.locator('#modalDesc').innerText()).includes('Required:'));
 assert.equal(await offline.locator('#btnApplied').isDisabled(),false);
 assert.deepEqual(errors,[]);
 console.log('PASS: browser tabs, counters, pagination, search, clusters, details, notes, application stages, offline/online snapshots, and failure handling.');
 console.log('Screenshot: '+fixture.root+'/live-dashboard.png');
} finally {await browser.close();}
