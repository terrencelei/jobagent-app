import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {greenhousePostingUnavailable} from '../src/posting-availability.mjs';

// Keep Chromium entirely on localhost; expose the production origin to the
// detector while preserving real browser responses and redirect ancestry.
function greenhouseResponse(response) {
 const wrap=request=>request&&({
  url:()=>`https://job-boards.greenhouse.io${new URL(request.url()).pathname}${new URL(request.url()).search}`,
  redirectedFrom:()=>wrap(request.redirectedFrom()),
  response:()=>request.response(),
 });
 return {request:()=>wrap(response.request())};
}

test('missing Greenhouse posting remains detectable after redirect to a loading careers page',async()=>{
 const requests=[];
 const server=createServer((req,res)=>{
  requests.push(req.method);
  if(req.url==='/fixture/jobs/123'){res.writeHead(302,{location:'/fixture?error=true'});res.end();}
  else if(req.url==='/fixture?error=true'){res.writeHead(302,{location:'/careers?'});res.end();}
  else {res.writeHead(200,{'content-type':'text/html'});res.end('<h1>Join Us</h1><p>Loading...</p>');}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let browser;
 try {
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();
  const response=await page.goto(`http://127.0.0.1:${server.address().port}/fixture/jobs/123`);
  assert.match(page.url(),/\/careers\?$/);
  assert.match(await page.locator('body').innerText(),/Loading/);
  assert.equal(await page.locator('input,button,a').count(),0);
  const wrapped=greenhouseResponse(response);
  assert.equal(await greenhousePostingUnavailable('https://boards.greenhouse.io/fixture/jobs/123',wrapped),true);
  assert.equal(await greenhousePostingUnavailable('https://job-boards.greenhouse.io/fixture/jobs/123',wrapped),true);
  assert.equal(await greenhousePostingUnavailable('https://boards.greenhouse.io/other/jobs/123',wrapped),false);
  assert.equal(await greenhousePostingUnavailable('https://boards.greenhouse.io/fixture/jobs/999',wrapped),false);
  assert.ok(requests.every(method=>method==='GET'));
 } finally {await browser?.close();await new Promise(r=>server.close(r));}
});

test('active postings, throttling, unrelated redirects and error text never imply closure',async()=>{
 let fixture;
 const server=createServer((req,res)=>{
  res.writeHead(req.url==='/fixture/jobs/123'?fixture.status:200,{'content-type':'text/html',...(req.url==='/fixture/jobs/123'&&fixture.location?{location:fixture.location}:{})});
  res.end(fixture.body??'Loading...');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let browser;
 try {
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();
  const posting='https://job-boards.greenhouse.io/fixture/jobs/123';
  for(const value of [
   {status:200,body:'<h1>Manufacturing Engineer</h1><form><input name="email"></form>'},
   {status:429,body:'Unusual traffic'},
   {status:503,body:'Something went wrong. Please refresh the page.'},
   {status:200,body:'Loading... error=true'},
   {status:302,location:'/another?error=true'},
   {status:302,location:'/fixture'},
  ]) {
   fixture=value;
   const response=await page.goto(`http://127.0.0.1:${server.address().port}/fixture/jobs/123`);
   assert.equal(await greenhousePostingUnavailable(posting,greenhouseResponse(response)),false,JSON.stringify(value));
  }
  for(const value of ['invalid','https://evil.invalid/fixture/jobs/123','https://job-boards.greenhouse.io/fixture','http://boards.greenhouse.io/fixture/jobs/123'])
   assert.equal(await greenhousePostingUnavailable(value,null),false);
 } finally {await browser?.close();await new Promise(r=>server.close(r));}
});
