import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {amazonPostingUnavailable} from '../src/posting-availability.mjs';

const job={title:'Aerospace Manufacturing Engineer - 2nd Shift, Amazon Leo',company:'Amazon',url:'https://account.amazon.jobs/jobs/10430622/apply'};
const notice="Sorry, the job you're looking for isn't available.";
// The saved 11845 page: header search with a hidden "city" input, then the notice.
const closedPage=`<header><input placeholder="Search for jobs by title or keyword"><input name="city" class="invisible" aria-label="city" style="display:none"><input placeholder="Location"></header><main><h1>${notice}</h1><p>There are other opportunities you might be interested in.</p></main>`;

async function serve(page,routes){
 await page.route('**/*',route=>{const u=new URL(route.request().url());return route.fulfill({status:200,contentType:'text/html',body:routes[u.hostname+u.pathname]??'<html></html>'});});
}

test('Amazon apply URL redirected to its jobs/404 page is an unavailable posting',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await serve(page,{'account.amazon.jobs/jobs/10430622/apply':'<script>location.replace("https://www.amazon.jobs/en/jobs/404")</script>','www.amazon.jobs/en/jobs/404':closedPage});
  await page.goto(job.url);await page.waitForURL(/jobs\/404/);
  assert.equal(await amazonPostingUnavailable(page,job),`Amazon says "Sorry, the job you're looking for isn't available" for this exact job.`);
 }finally{await browser.close();}
});

test('a live Amazon form, the notice on another path, or another host is not a closure',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await serve(page,{'account.amazon.jobs/jobs/10430622/apply':'<main><h1>Contact information</h1><input name="city"></main>','www.amazon.jobs/en/search':closedPage,'www.amazon.jobs/en/jobs/404':'<main>Search for jobs</main>'});
  await page.goto(job.url);
  assert.equal(await amazonPostingUnavailable(page,job),null,'live form');
  await page.goto('https://www.amazon.jobs/en/search');
  assert.equal(await amazonPostingUnavailable(page,job),null,'notice on a non-404 path');
  await page.goto('https://www.amazon.jobs/en/jobs/404');
  assert.equal(await amazonPostingUnavailable(page,job),null,'404 path without the notice');
  assert.equal(await amazonPostingUnavailable(page,{...job,url:'https://jobs.example.com/jobs/1/apply'}),null,'other host');
 }finally{await browser.close();}
});
