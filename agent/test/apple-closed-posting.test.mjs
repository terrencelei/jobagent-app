import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {applePostingUnavailable} from '../src/posting-availability.mjs';

const job={title:'Human Factors Engineer-ARC',company:'Apple',url:'https://jobs.apple.com/en-us/details/200688368-0836/human-factors-engineer-arc?team=HRDWR'};
const closedPage='<nav><h2>Shop</h2><input aria-label="Search"></nav><main><h1 class="t-eyebrow-elevated">Page not found.</h1><p>Sorry, this role does not exist or is no longer available.</p><a href="/en-us/search">Search Current Openings</a></main>';
const livePage='<main><h1>Human Factors Engineer-ARC</h1><a href="/app/en-us/apply/200688368-0836">Apply Now</a></main>';

async function serve(page,routes){
 await page.route('**/*',route=>{const u=new URL(route.request().url());return route.fulfill({status:200,contentType:'text/html',body:routes[u.pathname]??'<html></html>'});});
}

test('Apple details URL showing "Page not found" is an unavailable posting (11806)',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await serve(page,{'/en-us/details/200688368-0836/human-factors-engineer-arc':closedPage});
  await page.goto(job.url);
  assert.equal(await applePostingUnavailable(page,job),'Apple says "Page not found. Sorry, this role does not exist or is no longer available." for this exact job.');
 }finally{await browser.close();}
});

test('a live Apple posting, another role, a notice without the heading, or another host is not a closure',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await serve(page,{'/en-us/details/200688368-0836/human-factors-engineer-arc':livePage,'/en-us/details/999/other':closedPage,'/en-us/search':closedPage});
  await page.goto(job.url);
  assert.equal(await applePostingUnavailable(page,job),null,'live posting');
  await page.goto('https://jobs.apple.com/en-us/details/999/other');
  assert.equal(await applePostingUnavailable(page,job),null,'a different role id');
  await page.goto('https://jobs.apple.com/en-us/search');
  assert.equal(await applePostingUnavailable(page,job),null,'search page');
  await page.goto(job.url);
  await page.setContent('<main><h1>Human Factors Engineer-ARC</h1><p>Sorry, this role does not exist or is no longer available.</p></main>');
  assert.equal(await applePostingUnavailable(page,job),null,'notice without the Page not found heading');
  assert.equal(await applePostingUnavailable(page,{...job,url:'https://jobs.example.com/en-us/details/200688368-0836/x'}),null,'other host');
 }finally{await browser.close();}
});
