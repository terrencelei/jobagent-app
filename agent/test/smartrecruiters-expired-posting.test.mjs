import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {smartRecruitersPostingUnavailable} from '../src/posting-availability.mjs';

const job={title:'Mechanical Design Engineer',company:'Intuitive',url:'https://jobs.smartrecruiters.com/Intuitive/744000155524924-mechanical-design-engineer?oga=true'};
const expiredUrl='https://jobs.smartrecruiters.com/oneclick-ui/company/Intuitive/publication/b070c381-d2ef-4b00-901e-882478e788ee/expired?dcr_ci=Intuitive&jobId=13619964970';
const expired='<main><h2>This job ad has expired</h2><div class="placeholder"></div><p>Find more job offers at <a href="https://jobs.smartrecruiters.com">https://jobs.smartrecruiters.com</a></p></main>';
const live='<main><h1>Mechanical Design Engineer</h1><p>This job ad has expired</p><button>I\'m interested</button></main>';

async function open(page,target,body){
 await page.unroute('**/*');
 await page.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body}));
 await page.goto(target);
}

test('SmartRecruiters expired redirect for the same company is unavailable (Intuitive 12314)',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await open(page,expiredUrl,expired);
  assert.match(await smartRecruitersPostingUnavailable(page,job),/This job ad has expired/);
 }finally{await browser.close();}
});

test('an Apply control, another company, or a non-expired route is not a closure',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await open(page,expiredUrl,live);
  assert.equal(await smartRecruitersPostingUnavailable(page,job),null,'apply control present');
  await open(page,expiredUrl.replace('/Intuitive/','/OtherCo/'),expired);
  assert.equal(await smartRecruitersPostingUnavailable(page,job),null,'different company');
  await open(page,'https://jobs.smartrecruiters.com/Intuitive/744000155524924-mechanical-design-engineer',expired);
  assert.equal(await smartRecruitersPostingUnavailable(page,job),null,'not the expired route');
  await open(page,expiredUrl.replace('jobs.smartrecruiters.com','jobs.example.com'),expired);
  assert.equal(await smartRecruitersPostingUnavailable(page,job),null,'different host');
 }finally{await browser.close();}
});
