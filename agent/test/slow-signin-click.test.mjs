import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {clickAuthControl} from '../src/dashboard-worker.mjs';

// Hyundai 11914 (SuccessFactors): Sign In posts the login form and the server takes over 10 s to answer.
// The click itself succeeded, but waiting for that navigation inside click() hit the 10 s timeout and failed the run.
test('a sign-in click does not fail while a slow login response is pending',async()=>{
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();page.setDefaultTimeout(1000);
  await page.route('https://career.example.com/careers',r=>r.fulfill({contentType:'text/html',body:`<form method="post" action="/login">
   <input name="username"><button onclick="return validateFields();">Sign In</button></form><script>function validateFields(){return true;}</script>`}));
  await page.route('https://career.example.com/login',async r=>{await new Promise(res=>setTimeout(res,2500));await r.fulfill({contentType:'text/html',body:'<h1>Signed in</h1>'});});
  await page.goto('https://career.example.com/careers');
  await clickAuthControl(page,page.getByRole('button',{name:'Sign In'}),{loadTimeout:8000});
  assert.equal(await page.locator('h1').textContent(),'Signed in');
 }finally{await browser.close();}
});
