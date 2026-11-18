import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {successFactorsPostingUnavailable} from '../src/posting-availability.mjs';

const url='https://careers.huntingtoningalls.com/job/Newport-News-ENGINEER-MECHANICAL-1-Virg/1441014100/';
const job={title:'ENGINEER MECHANICAL 1',company:'HII',url};
const closed='<header><form><input placeholder="Search by Keyword"><button>Search Jobs</button></form></header><main><p>Thank you for your interest.  This position is no longer posted at this time.</p><div><input type="email" placeholder="Email Address"><button>Create Alert</button></div></main><button>Accept All Cookies</button>';
const live='<main><h1>ENGINEER MECHANICAL 1</h1><p>This position is no longer posted at this time.</p><a href="/talentcommunity/apply/1/">Apply now</a></main>';

async function open(page,target,body){
 await page.unroute('**/*');
 await page.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body}));
 await page.goto(target);
}

test('SuccessFactors RMK closed posting is unavailable on the same host and job id (HII 12780)',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await open(page,url,closed);
  assert.match(await successFactorsPostingUnavailable(page,job),/This position is no longer posted at this time/);
 }finally{await browser.close();}
});

test('an RMK page with Apply, another job id or host is not a closure',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await open(page,url,live);
  assert.equal(await successFactorsPostingUnavailable(page,job),null,'Apply control present');
  await open(page,'https://careers.huntingtoningalls.com/job/Newport-News-OTHER/1441099999/',closed);
  assert.equal(await successFactorsPostingUnavailable(page,job),null,'different job id');
  await open(page,'https://careers.example.com/job/Newport-News-ENGINEER-MECHANICAL-1-Virg/1441014100/',closed);
  assert.equal(await successFactorsPostingUnavailable(page,job),null,'different host');
  await open(page,'https://careers.huntingtoningalls.com/search/?q=engineer',closed);
  assert.equal(await successFactorsPostingUnavailable(page,{...job,url:'https://careers.huntingtoningalls.com/search/?q=engineer'}),null,'not a job URL');
 }finally{await browser.close();}
});
