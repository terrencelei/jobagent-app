import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {validatePublicURL} from '../src/public-url.mjs';

const dnsError=code=>Object.assign(new Error(`getaddrinfo ${code} fixture.example`),{code});

for(const code of ['ENOTFOUND','EAI_AGAIN'])test(`public URL recovers from ${code} with bounded waits`,async()=>{
 let calls=0;const waits=[];
 await validatePublicURL('https://fixture.example',false,{
  resolveHost:async(host,options)=>{assert.equal(host,'fixture.example');assert.deepEqual(options,{all:true});if(++calls<3)throw dnsError(code);return[{address:'93.184.216.34'}];},
  wait:async ms=>waits.push(ms),
 });
 assert.equal(calls,3);assert.deepEqual(waits,[1000,2000]);
});

test('permanent DNS and non-DNS errors fail closed',async()=>{
 for(const code of ['ENOTFOUND','EAI_AGAIN','EACCES']){
  let calls=0;const waits=[];const error=dnsError(code);
  await assert.rejects(validatePublicURL('https://fixture.example',false,{
   resolveHost:async()=>{calls++;throw error;},wait:async ms=>waits.push(ms),
  }),e=>e===error);
  assert.equal(calls,code==='EACCES'?1:3);assert.equal(waits.length,calls-1);
 }
});

test('healthy DNS emits no retry or recovery events',async()=>{
 await validatePublicURL('https://fixture.example',false,{
  resolveHost:async()=>[{address:'93.184.216.34'}],
  onRetry:async()=>assert.fail('No DNS retry expected'),
  onRecovered:async()=>assert.fail('No DNS recovery expected'),
 });
});

for(const outcome of ['recovered','offline','private','throttled'])test(`worker Chromium navigation DNS fixture: ${outcome}`,async()=>{
 let gets=0,submits=0,calls=0;const retries=[],recovered=[];
 const server=createServer((req,res)=>{
  if(req.method==='POST')submits++;else gets++;
  res.statusCode=outcome==='throttled'?429:200;
  res.setHeader('Content-Type','text/html');
  res.end('<form method="post"><label>Name<input required></label><button>Submit application</button></form>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  let failure;
  await context.route('**/*',async route=>{
   if(route.request().isNavigationRequest()){
    try{await validatePublicURL(route.request().url(),false,{
     resolveHost:async()=>{calls++;if(outcome==='offline'||calls<3)throw dnsError('ENOTFOUND');return[{address:outcome==='private'?'127.0.0.1':'93.184.216.34'}];},wait:async()=>{},
     onRetry:async info=>retries.push(info),onRecovered:async info=>recovered.push(info),
    });}catch(error){failure=error;return route.abort();}
   }
   const response=await context.request.get(`http://127.0.0.1:${server.address().port}`);
   return route.fulfill({response});
  });
  const page=await context.newPage();
  const navigation=page.goto('https://fixture.example',{waitUntil:'domcontentloaded'});
  if(['recovered','throttled'].includes(outcome)){
   assert.equal((await navigation).status(),outcome==='throttled'?429:200);assert.equal(await page.getByLabel('Name').count(),1);assert.equal(gets,1);assert.equal(failure,undefined);
  }else{
   await assert.rejects(navigation,/ERR_FAILED/);assert.equal(gets,0);
   if(outcome==='offline')assert.equal(failure.code,'ENOTFOUND');else assert.match(failure.message,/Private network/);
  }
  assert.equal(calls,3);assert.equal(submits,0);
  assert.deepEqual(retries,[{host:'fixture.example',code:'ENOTFOUND',attempt:1,delay:1000},{host:'fixture.example',code:'ENOTFOUND',attempt:2,delay:2000}]);
  assert.deepEqual(recovered,['recovered','throttled'].includes(outcome)?[{host:'fixture.example',retries:2}]:[]);
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
