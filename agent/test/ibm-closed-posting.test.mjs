import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {ibmPostingUnavailable} from '../src/posting-availability.mjs';

const job={title:'Associate Quantum Hardware Assembly R&D Engineer',company:'IBM',url:'https://careers.ibm.com/en_US/careers/JobDetail?jobId=130456'};
const notice='Sorry, this job is closed and we are no longer accepting applications';
const closedPage=`<main><h1>IBM Careers</h1><p>${notice} - but let's keep in touch!</p><form><label>First Name<input></label><button>Submit</button></form></main>`;
const livePage='<main><h1>Associate Quantum Hardware Assembly R&D Engineer</h1><button>Apply now</button></main>';

async function serve(page,routes){
 await page.route('**/*',route=>{const u=new URL(route.request().url());const body=routes[u.pathname]??'<html></html>';return route.fulfill({status:202,contentType:'text/html',body});});
}

test('IBM detail URL that the site moves to its closedjob page is an unavailable posting',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await serve(page,{'/en_US/careers/JobDetail':'<script>location.replace("/en_US/closedjob")</script>','/en_US/closedjob':closedPage});
  await page.goto(job.url);await page.waitForURL(/closedjob/);
  assert.equal(await ibmPostingUnavailable(page,job),`IBM says "${notice}" for this exact job.`);
 }finally{await browser.close();}
});

test('a live IBM posting, a notice elsewhere, or another host is not a closure',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await serve(page,{'/en_US/careers/JobDetail':livePage,'/en_US/closedjob':closedPage,'/en_US/talent':closedPage});
  await page.goto(job.url);
  assert.equal(await ibmPostingUnavailable(page,job),null,'live posting');
  await page.goto('https://careers.ibm.com/en_US/talent');
  assert.equal(await ibmPostingUnavailable(page,job),null,'notice on a page that is not closedjob');
  await page.goto('https://careers.ibm.com/en_US/closedjob');
  assert.equal(await ibmPostingUnavailable(page,{...job,url:'https://careers.ibm.com/en_US/search'}),null,'posting URL is not a JobDetail');
  assert.equal(await ibmPostingUnavailable(page,{...job,url:'https://jobs.example.com/en_US/careers/JobDetail?jobId=1'}),null,'other host');
  await page.setContent('<main><p>Join our Talent Network</p></main>',{waitUntil:'domcontentloaded'});
  assert.equal(await ibmPostingUnavailable(page,job),null,'closedjob path without the notice');
 }finally{await browser.close();}
});
