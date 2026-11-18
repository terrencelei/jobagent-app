// Isolated browser check; every API request is mocked, including mutations.
import {createRequire} from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ui=new URL('../src/jobagent/ui/',import.meta.url);
const server=http.createServer((req,res)=>{
 const route=new URL(req.url,'http://localhost').pathname;
 const file={'/':'templates/index.html','/approvals':'templates/approvals.html','/help':'templates/help.html'}[route] || route.slice(1);
 if(!/^(?:templates\/(?:index|help|approvals)\.html|(?:feedback|dashboard|applications|approvals|help)\.js|applications\.css)$/.test(file)){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(new URL(file,ui)));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});
try{
 for(const [path,selector] of [['/','#settingsSave'],['/approvals','#recheck'],['/help','[data-act="retry"]']]){
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let release,posts=0,fail=false;
  await page.route('https://**',r=>r.abort());
  await page.route('**/api/**',async route=>{
   const url=new URL(route.request().url()).pathname;
   if(route.request().method()==='POST'){
    posts++;await new Promise(r=>release=r);
    return route.fulfill({status:fail?400:200,json:fail?{detail:'Fixture failure'}:{settings:[],changed:[],needs:[],resumed:1}});
   }
   const body=url==='/api/status'?{counts:{},source_counts:{}}:url==='/api/jobs'?{jobs:[],total:0}:url.endsWith('/approvals')?{approvals:[]}:url.endsWith('/caps')?{caps:[]}:url.endsWith('/help')?{items:[{job_id:55,id:'help-55',status:'failed',title:'Fixture',company:'Fixture'}]}:url.endsWith('/chat')?{job_id:55,messages:[],busy:false}:{};
   return route.fulfill({json:body});
  });
  await page.goto(origin+path);
  if(path==='/')await page.evaluate(()=>document.getElementById('settingsModal').classList.remove('hidden'));
  const button=page.locator(selector);
  await button.click();await page.waitForFunction(s=>document.querySelector(s)?.dataset.uiPending==='true',selector);
  assert.equal(await button.getAttribute('aria-busy'),'true');
  assert.equal(await button.evaluate(el=>getComputedStyle(el,'::after').animationName),'ui-spin');
  await button.evaluate(el=>el.click());assert.equal(posts,1,'pending action must not send duplicate requests');
  release();await page.waitForFunction(s=>!document.querySelector(s)?.dataset.uiPending,selector);
  assert.equal(await page.locator('#uiFeedback').isVisible(),true);assert.equal(await page.locator('#uiFeedback').getAttribute('role'),'status');
  fail=true;await button.click();await page.waitForFunction(s=>document.querySelector(s)?.dataset.uiPending==='true',selector);release();
  await page.waitForFunction(()=>document.getElementById('uiFeedback').textContent.includes('Fixture failure'));
  assert.equal(await page.locator('#uiFeedback').getAttribute('role'),'alert');
  assert.equal(await button.getAttribute('aria-busy'),null);
  // A background refresh does not turn another control into a loading control or change the toast.
  const text=await page.locator('#uiFeedback').innerText();
  await page.waitForTimeout(5100);
  assert.equal(await page.locator('[data-ui-pending="true"]').count(),0);
  assert.equal(await page.locator('#uiFeedback').innerText(),text);
  assert.deepEqual(errors,[]);
  await page.close();
 }
 // Listing cards are rebuilt by dashboard refreshes while queue requests are pending.
 const page=await browser.newPage();let release;
 await page.route('https://**',r=>r.abort());
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url()).pathname;
  if(url.endsWith('/queue')){await new Promise(r=>release=r);return route.fulfill({json:{added:1}});}
  if(/^\/api\/jobs\/(999|1000)$/.test(url))return route.fulfill({json:{id:Number(url.split('/').pop()),company_name:'Fixture',title:'Fixture',status:'NEW',role_type:'FULL_TIME',eligibility:url.endsWith('/999')?'ELIGIBLE':'LIKELY_ELIGIBLE'}});
  return route.fulfill({json:url==='/api/status'?{counts:{},source_counts:{}}:url==='/api/jobs'?{jobs:[],total:0}:url.endsWith('/approvals')?{approvals:[]}:url.endsWith('/help')?{items:[]}: {}});
 });
 await page.goto(origin);
 const rebuild=()=>page.evaluate(()=>{
  document.querySelector('.job-card[data-job-id="999"]')?.remove();
  document.body.append(createJobCard({id:999,status:'NEW',role_type:'FULL_TIME',eligibility:'ELIGIBLE',title:'Fixture',company_name:'Fixture'}));
 });
 await rebuild();
 const button=page.locator('[data-queue-job="999"][data-queue-position="end"]');
 await button.click();assert.equal(await button.textContent(),'Queueing…');
 await rebuild();assert.equal(await button.textContent(),'Queueing…');assert.equal(await button.isDisabled(),true);
 release();await page.waitForFunction(()=>document.querySelector('[data-queue-job="999"][data-queue-position="end"]').textContent==='Queued ✓');
 await rebuild();assert.equal(await button.textContent(),'Queued ✓');
 assert.equal(await page.locator('[data-queue-status="999"]').textContent(),'Application added to your queue.');
 await page.evaluate(()=>openDetail(999));
 const modalButton=page.locator('#btnQueueApplication'),modalStatus=page.locator('#modalQueueFeedback');
 assert.equal(await modalButton.isVisible(),true);
 await modalButton.click();assert.equal(await modalButton.textContent(),'Queueing…');assert.match(await modalStatus.textContent(),/Adding/);
 await page.evaluate(()=>setControls());assert.equal(await modalButton.isDisabled(),true);
 release();await page.waitForFunction(()=>document.getElementById('btnQueueApplication').textContent==='Queued ✓');
 assert.equal(await modalStatus.textContent(),'Application added to your queue.');
 await page.evaluate(()=>openDetail(1000));
 // A Likely-eligible role queues in one click by recording his Good fit label (def4b82, 2026-10-19).
 assert.equal(await modalButton.isVisible(),true);assert.equal(await modalButton.isDisabled(),false);assert.equal(await modalButton.textContent(),'Mark Good fit & queue');
 // A role he marked not a fit stays unqueueable, with the reason shown.
 await page.evaluate(()=>{activeJob.user_fit_label={fit:false};setControls();});
 assert.equal(await modalButton.isDisabled(),true);assert.match(await modalStatus.textContent(),/not a fit/);
 await page.close();
 console.log('PASS: dashboard, Approvals and Needs Help feedback; duplicate protection; quiet polling; listing feedback survives refreshes; posting detail shows inline queue feedback and queues Likely-eligible roles in one click and explains unavailable queueing.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
