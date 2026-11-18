import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,basename} from 'node:path';import {createHash} from 'node:crypto';
import {reviewedWebpageAcceptance} from '../tools/verify-application-receipt.mjs';
test('historical webpage acceptance binds reviewed screenshot to exact run and submission',async()=>{
 const run=await mkdtemp(join(tmpdir(),'reviewed-page-'));try{
  const screenshotPath=join(run,'screenshot.jpg');await writeFile(screenshotPath,'fixture confirmation screenshot');
  const job={id:1,company:'Example',title:'Mechanical Engineer',url:'https://jobs.ashbyhq.com/example/job/application'};
  const durable={canonicalUrl:job.url,submittedAt:'2026-10-15T12:00:00Z'};
  const record={durableSha256:createHash('sha256').update(JSON.stringify(durable)).digest('hex'),runId:basename(run),jobId:1,canonicalUrl:job.url,screenshotPath,screenshotSha256:createHash('sha256').update('fixture confirmation screenshot').digest('hex'),submittedAt:durable.submittedAt,confirmedAt:'2026-10-15T12:01:00Z',url:job.url,text:'Your application has been submitted'};
  const check=value=>reviewedWebpageAcceptance(value,{run,request:{job},durable});
  assert.equal((await check(record)).source,'webpage');
  for(const change of [{durableSha256:'0'.repeat(64)},{runId:'other'},{jobId:2},{canonicalUrl:job.url+'other'},{submittedAt:'2026-10-14T12:00:00Z'},{screenshotPath:join(run,'another.jpg')},{screenshotSha256:'0'.repeat(64)},{text:'Submit Application'},{text:'Unable to submit your application'}])assert.equal(await check({...record,...change}),null);
  await writeFile(screenshotPath,'new screenshot');assert.equal(await check(record),null);
 }finally{await rm(run,{force:true,recursive:true});}
});
