// Isolated browser regression: fixtures replace every application API response.
// Run with PLAYWRIGHT_MODULE=/path/to/playwright node tests/browser_approvals_smoke.mjs
import {createRequire} from 'node:module';
import http from 'node:http';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
import fs from 'node:fs';
import assert from 'node:assert/strict';
const ui=new URL('../src/jobagent/ui/',import.meta.url);
const server=http.createServer((req,res)=>{
 const file={'/approvals':'templates/approvals.html','/approvals.js':'approvals.js','/applications.css':'applications.css'}[req.url];
 if(!file) {res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');
 res.end(fs.readFileSync(new URL(file,ui)));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let polls=0;
 const questions=[{label:'Answer',required:true,type:'textarea'},{label:'Choice',options:['Yes','No']}];
 await page.route('**/api/applications/**',route=>{
  const path=new URL(route.request().url()).pathname;
  let body={};
  if(path.endsWith('/approvals')) {polls++;body={approvals:[{id:'focus',job_id:1,status:'needs_approval',company:'Fixture',title:'Editing',updated_at:String(polls),questions},...(polls>1?[{id:'other',job_id:2,status:'needs_approval',company:'Fixture',title:`Other updated ${polls}`,updated_at:String(polls),questions:[]}]:[])]};}
  else if(path.endsWith('/help')) body={items:[]};
  else if(path.endsWith('/caps')) body={caps:[]};
  return route.fulfill({json:body});
 });
 if(process.argv[2]) await page.route('**/approvals.js',route=>route.fulfill({body:fs.readFileSync(process.argv[2],'utf8'),contentType:'text/javascript'}));
 await page.goto(origin+'/approvals');
 const text=page.locator('[data-card="focus"] textarea');
 await text.fill('My unfinished answer');
 await text.evaluate(el=>{window.originalText=el;el.setSelectionRange(3,8);});
 await page.waitForFunction(()=>document.querySelector('[data-card="other"]'));
 assert.equal(await text.evaluate(el=>el===window.originalText&&document.activeElement===el),true,'poll must retain the original focused textarea');
 assert.deepEqual(await text.evaluate(el=>[el.value,el.selectionStart,el.selectionEnd]),['My unfinished answer',3,8]);
 const select=page.locator('[data-card="focus"] select');
 await select.selectOption('Yes');await select.focus();
 await select.evaluate(el=>window.originalSelect=el);
 const before=polls;
 await page.waitForFunction(n=>document.querySelector('[data-card="other"] strong').textContent!==`Other updated ${n}`,before);
 assert.equal(await select.evaluate(el=>el===window.originalSelect&&document.activeElement===el&&el.value==='Yes'),true,'poll must retain the original dropdown and selection');
 await page.locator('h1').click();
 await page.waitForFunction(n=>document.querySelector('[data-card="focus"]').dataset.sig.includes(`"${n+1}"`),polls);
 assert.equal(await text.inputValue(),'My unfinished answer');assert.equal(await select.inputValue(),'Yes');
 assert.deepEqual(errors,[]);
 console.log('PASS: polling preserved textarea focus/caret, dropdown node/focus/selection, drafts after blur, and updates on other cards.');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
