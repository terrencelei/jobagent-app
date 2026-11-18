import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {reviewedWebpageAcceptance} from '../tools/verify-application-receipt.mjs';

// ArcBest 12717: the posting is on arcbest.avature.net, the application and its "Thank you for applying" page on
// careers.arcb.com. The worker's own last observed URL vouches for the redirect host; nothing else does.
test('reviewed success page on the posting redirect host is bound to the worker-observed URL',async()=>{
 const run=await mkdtemp(join(tmpdir(),'reviewed-redirect-'));try{
  const screenshotPath=join(run,'screenshot.jpg');await writeFile(screenshotPath,'fixture success screenshot');
  const job={id:12717,company:'ArcBest',title:'Test and Reliability Engineer I',url:'https://arcbest.avature.net/careersmarketplace/JobDetail?id=29813&source=Indeed'};
  const success='https://careers.arcb.com/careersmarketplace/Success?jobId=29813&source=Indeed';
  const durable={canonicalUrl:job.url,submittedAt:'2026-10-24T01:24:21.106Z'};
  const record={durableSha256:createHash('sha256').update(JSON.stringify(durable)).digest('hex'),runId:basename(run),jobId:12717,canonicalUrl:job.url,screenshotPath,screenshotSha256:createHash('sha256').update('fixture success screenshot').digest('hex'),submittedAt:durable.submittedAt,confirmedAt:'2026-10-24T01:24:21.106Z',url:success,text:'Thank you for applying! You have applied for Test and Reliability Engineer I - Vaux in Fort Smith, Arkansas, United States'};
  const check=(value,state)=>reviewedWebpageAcceptance(value,{run,request:{job},durable,state});
  const ok=await check(record,{url:success});
  assert.equal(ok?.source,'webpage');assert.equal(ok.applicationUrl,job.url);assert.equal(ok.url,success);
  // Without the worker's observation of that exact page, the other host is not trusted.
  assert.equal(await check(record,{url:job.url}),null);
  assert.equal(await check(record,{}),null);
  assert.equal(await check(record,{url:'https://careers.arcb.com/careersmarketplace/Profile'}),null);
  assert.equal(await check({...record,url:'https://evil.example/Success'},{url:success}),null);
 }finally{await rm(run,{recursive:true,force:true});}
});
