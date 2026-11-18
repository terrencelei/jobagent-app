// Isolated approval mutations: no requests reach the live dashboard or employers.
import {createRequire} from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ui=new URL('../src/jobagent/ui/',import.meta.url);
const server=http.createServer((req,res)=>{
 const file={'/approvals':'templates/approvals.html','/approvals.js':'approvals.js','/feedback.js':'feedback.js','/applications.css':'applications.css'}[req.url];
 if(!file){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');
 res.end(fs.readFileSync(new URL(file,ui)));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage(), errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const item=(id,status='needs_approval')=>({id:String(id),job_id:id,status,title:`Posting ${id}`,company:'Fixture',
  questions:[{id:'answer',label:'Answer',type:'textarea',required:true}],updated_at:'2026-10-15'});
 let approvals=[item(1),item(2),item(3),item(4),item(5,'waiting_answers'),item(6,'ready_to_submit')];
 let caps=[{company:'Fixture',status:'pending',max:5,days:30}];
 let holdNext=false, heldRoute, heldData;
 const mutations=[];
 await page.route('**/api/applications/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;
  if(req.method()==='POST'){
   const body=req.postDataJSON(), id=Number(path.match(/\/jobs\/(\d+)/)?.[1]);
   mutations.push({path,body});
   if(id===3&&path.endsWith('/approve-answers'))return route.fulfill({status:400,json:{detail:'Please correct this answer.'}});
   if(path==='/api/applications/caps')caps=caps.map(c=>({...c,status:'approved'}));
   // Return stale data for skip and live-answer commands to mimic a lagging worker/poll.
   if(![2,5].includes(id))approvals=approvals.filter(w=>w.job_id!==id&&!(id===1&&w.job_id===4));
   return route.fulfill({json:{ok:true,...(id===1?{also_resumed:[4]}:{})}});
  }
  if(path.endsWith('/approvals')){
   if(holdNext){holdNext=false;heldRoute=route;heldData=structuredClone(approvals);return;}
   return route.fulfill({json:{approvals}});
  }
  return route.fulfill({json:path.endsWith('/caps')?{caps}:{items:[]}});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/approvals`);
 await page.waitForFunction(()=>document.querySelectorAll('#content article[data-card]').length===6);
 // Let a pre-mutation poll return only after the successful action's fresh read.
 holdNext=true;
 await page.waitForTimeout(4400);
 assert.ok(heldRoute,'fixture must hold an in-flight background read');
 await page.locator('article[data-card="1"] textarea').fill('Approved answer');
 await page.locator('article[data-card="1"] button[type=submit]').click();
 await page.waitForFunction(()=>!document.querySelector('article[data-card="1"]'));
 assert.equal(await page.locator('article[data-card="4"]').count(),0,'also-resumed cards disappear too');
 await heldRoute.fulfill({json:{approvals:heldData}});
 await page.waitForTimeout(100);
 assert.equal(await page.locator('article[data-card="1"]').count(),0,'old poll cannot resurrect an approved card');
 assert.match(await page.title(),/^\(4\)/);
 // A stale endpoint can update metadata on an already approved run. Its entire
 // old card must stay removed; a genuinely new run has a different id.
 approvals.push({...item(1),message:'Delayed metadata update',questions:[{label:'Old question with a regenerated draft',draft:'Old draft'}]});
 await page.locator('article[data-card="2"] [data-act=dismiss]').click();
 await page.waitForFunction(()=>!document.querySelector('article[data-card="2"]'));
 assert.match(await page.title(),/^\(3\)/);
 await page.locator('article[data-card="3"] textarea').fill('Keep my draft');
 await page.locator('article[data-card="3"] button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Please correct'));
 assert.equal(await page.locator('article[data-card="3"] textarea').inputValue(),'Keep my draft');
 assert.equal(await page.locator('article[data-card="3"]').count(),1,'failed action must retain its card');
 await page.locator('article[data-card="5"] textarea').fill('Live answer');
 await page.locator('article[data-card="5"] button[type=submit]').click();
 await page.waitForFunction(()=>!document.querySelector('article[data-card="5"]'));
 // Final reviews submit automatically (his instruction, 2026-10-18): no approve button, and the
 // card leaves once the worker has submitted.
 assert.equal(await page.locator('article[data-card="6"] [data-act=approve-submit]').count(),0);
 assert.match(await page.locator('article[data-card="6"]').textContent(),/Submitting automatically/);
 approvals=approvals.filter(w=>w.job_id!==6);
 await page.waitForFunction(()=>!document.querySelector('article[data-card="6"]'));
 assert.match(await page.title(),/^\(1\)/);
 // A new question on the same live worker must become actionable again.
 approvals=approvals.map(w=>w.job_id===5?{...w,questions:[{id:'next',label:'Next question',required:true}]}:w);
 await page.waitForFunction(()=>document.querySelector('article[data-card="5"] label')?.textContent.includes('Next question'));
 assert.equal(await page.locator('article[data-card="1"]').count(),0,'approved posting cannot return when old-run metadata changes');
 assert.equal(await page.locator('article[data-card="2"]').count(),0,'stale skipped card remains suppressed');
 await page.locator('[data-cap-form] button[type=submit]').click();
 await page.waitForFunction(()=>!document.querySelector('[data-cap-form]'));
 assert.match(await page.locator('#caps').textContent(),/allowed, limit enforced/);
 await page.locator('article[data-card="3"] [data-act=dismiss]').click();
 await page.waitForFunction(()=>!document.querySelector('article[data-card="3"]'));
 await page.locator('article[data-card="5"] input').fill('Next answer');
 await page.locator('article[data-card="5"] button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('#content > .app-empty'));
 assert.equal(await page.title(),'Approvals · JobAgent');
 assert.equal(await page.locator('#clearList').isDisabled(),true);
 assert.equal(await page.locator('#content article[data-card]').count(),0);
 approvals.push({...item(1),id:'new-run',questions:[{label:'New required question'}]});
 await page.waitForFunction(()=>document.querySelector('article[data-card="new-run"]'));
 assert.equal(await page.locator('article[data-card="1"]').count(),0,'only a new approval run may return');
 assert.equal(mutations.filter(m=>m.path.endsWith('/approve-submit')).length,0);
 assert.deepEqual(errors,[]);
 console.log('PASS: approve/skip/live/auto-submit/cap actions update cards, counts and empty state; stale polls stay discarded; failures retain drafts; new live questions return.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
