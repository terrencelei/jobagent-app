import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {oraclePostingUnavailable} from '../src/posting-availability.mjs';

const base='https://icfcjb.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites';
const job={title:'Advanced Manufacturing Engineer I',company:'Honeywell Aerospace',url:`${base}/CX_1/requisitions/preview/125630`};
const closed='<header>Honeywell Aerospace</header><main><h2>This job is no longer available.</h2><p>You may also <button>View all jobs</button>.</p></main>';
const live='<main><h1>Advanced Manufacturing Engineer I</h1><p>This job is no longer available.</p><button>Apply Now</button></main>';

async function open(page,url,body){
 await page.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body}));
 await page.goto(url);
}

test('Oracle CX closed requisition is unavailable on the same tenant and id, even after a site redirect (12972)',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await open(page,`${base}/Aerospace/job/125630`,closed);
  assert.match(await oraclePostingUnavailable(page,job),/This job is no longer available/);
 }finally{await browser.close();}
});

test('an Oracle page with Apply, another requisition, tenant or host is not a closure',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await open(page,`${base}/Aerospace/job/125630`,live);
  assert.equal(await oraclePostingUnavailable(page,job),null,'Apply control present');
  await page.unroute('**/*');
  await open(page,`${base}/Aerospace/job/999999`,closed);
  assert.equal(await oraclePostingUnavailable(page,job),null,'different requisition');
  await page.unroute('**/*');
  await open(page,'https://other.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/125630',closed);
  assert.equal(await oraclePostingUnavailable(page,job),null,'different tenant');
  await page.unroute('**/*');
  await open(page,'https://careers.example.com/hcmUI/CandidateExperience/en/sites/CX_1/job/125630',closed);
  assert.equal(await oraclePostingUnavailable(page,{...job,url:'https://careers.example.com/hcmUI/CandidateExperience/en/sites/CX_1/job/125630'}),null,'not Oracle');
 }finally{await browser.close();}
});

// Second 12972 run: Oracle CX is a single-page app, so the first paint after the redirect held only its
// "Skip to main content" link; the closure check read that and returned null, and the role went to needs_human.
test('Oracle CX closure that paints after the "Skip to main content" first render is still detected (12972)',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  const spa='<a href="#main">Skip to main content</a><div id="root"></div><script>setTimeout(()=>{document.getElementById("root").innerHTML='+JSON.stringify(closed)+'},1200)</script>';
  await open(page,`${base}/Aerospace/job/125630`,spa);
  assert.equal(await page.locator('body').innerText(),'Skip to main content');
  assert.match(await oraclePostingUnavailable(page,job),/This job is no longer available/);
  // A page that has already rendered other content (an apply step, a live posting without a plain Apply label) is decided at once.
  await page.unroute('**/*');
  await open(page,`${base}/Aerospace/job/125630/apply/email`,'<a href="#main">Skip to main content</a><main><label>Email <input></label><button>Continue</button></main>');
  const started=Date.now();
  assert.equal(await oraclePostingUnavailable(page,job),null);
  assert.ok(Date.now()-started<2000,'rendered page is not waited on');
  // A page that never renders is given up after the timeout, not treated as closed.
  await page.unroute('**/*');
  await open(page,`${base}/Aerospace/job/125630`,'<a href="#main">Skip to main content</a>');
  assert.equal(await oraclePostingUnavailable(page,job,{timeout:400}),null);
 }finally{await browser.close();}
});
