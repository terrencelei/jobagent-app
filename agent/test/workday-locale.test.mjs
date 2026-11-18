import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {englishWorkdayApplicationUrl,openWorkdayApplicationPage} from '../src/workday-opening.mjs';
import {openWorkdayBrowser} from '../src/workday-browser.mjs';
import {stepOf} from '../src/workday.mjs';

const origin='https://fixture.wd5.myworkdayjobs.com';
const path='/careers/job/US-AZ/Mechanical-Test-Engineer-I_R123/apply';

test('initial Workday application URL selects English without changing job identity or query',()=>{
 for(const locale of ['','/fr-CA','/en-US']) {
  assert.equal(englishWorkdayApplicationUrl(origin+locale+path+'?source=fixture'),origin+'/en-US'+path+'?source=fixture');
 }
 for(const url of [origin+'/careers/verify?token=fixture',origin+'/careers/login',origin+path.replace('/apply',''),'https://example.com'+path,'https://fixture.wd5.myworkdayjobs.com.example.com'+path]) {
  assert.equal(englishWorkdayApplicationUrl(url),url);
 }
});

test('localized persistent Workday browser opens the English application wizard using an intercepted fixture',async()=>{
 const root=await mkdtemp(join(tmpdir(),'workday-locale-'));
 let context;
 const requests=[];
 try {
  context=await openWorkdayBrowser(chromium,join(root,'profile'),{headless:true,locale:'fr-CA',viewport:{width:1280,height:1000}});
  await context.route('**/*',async route=>{
   const req=route.request();requests.push({url:req.url(),method:req.method()});
   const english=new URL(req.url()).pathname.startsWith('/en-US/');
   await route.fulfill({contentType:'text/html',body:english
    ? '<h1>Start Your Application</h1><button onclick="document.body.innerText=\'current step 1 of 5\\nMy Information\'">Apply Manually</button>'
    : '<h1>Commencer sa candidature</h1><button>Postuler manuellement</button>'});
  });
  const page=context.pages()[0];
  await page.goto(origin+path);
  assert.equal(await page.locator('h1').innerText(),'Commencer sa candidature');
  assert.equal(await page.getByRole('button',{name:'Apply Manually',exact:true}).count(),0);
  assert.equal(stepOf(await page.locator('body').innerText()),null);
  await openWorkdayApplicationPage(page,origin+path+'?source=fixture');
  assert.equal(await page.locator('h1').innerText(),'Start Your Application');
  await page.getByRole('button',{name:'Apply Manually',exact:true}).click();
  assert.deepEqual(stepOf(await page.locator('body').innerText()),{n:1,of:5,name:'My Information'});
  assert.equal(page.url(),origin+'/en-US'+path+'?source=fixture');
  assert.ok(requests.every(r=>r.method==='GET'));
  assert.equal(requests.length,2);
 } finally {await context?.close();await rm(root,{recursive:true,force:true});}
});
