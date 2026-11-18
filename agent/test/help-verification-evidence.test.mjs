import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtemp,writeFile,mkdir,rm}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';import{createHash}from'node:crypto';import{spawnSync}from'node:child_process';
test('a reviewed unaccepted gate requires the exact run, canonical posting, state and screenshot',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'verification-evidence-'));try{
  const runId='fixture-run';await mkdir(join(dir,runId));await writeFile(join(dir,runId,'screenshot.jpg'),'reviewed gate');
  const url='https://job-boards.greenhouse.io/example/jobs/123456';
  await writeFile(join(dir,'queue.json'),JSON.stringify({jobs:[{job_id:1,id:runId}]}));
  const proof={resolution:'not_accepted',runId,canonicalUrl:url,screenshotSha256:createHash('sha256').update('reviewed gate').digest('hex')};
  const request={receiptFile:join(dir,'receipts.json'),items:[{job_id:1,job:{company:'Example',title:'Engineer',url},durable:{status:'awaiting_verification_code',canonicalUrl:url}}]};
  const audit=()=>{const r=spawnSync(process.execPath,['tools/reconcile-help.mjs'],{input:JSON.stringify(request),encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout)[0];};
  await writeFile(join(dir,'help-verification-evidence.json'),JSON.stringify({'1':proof}));
  assert.equal(audit().verificationNotAccepted,true);
  await writeFile(join(dir,runId,'screenshot.jpg'),'different page');assert.equal(audit().verificationNotAccepted,false);
  await writeFile(join(dir,runId,'screenshot.jpg'),'reviewed gate');request.items[0].durable.status='submission_unknown';assert.equal(audit().verificationNotAccepted,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('reviewed incomplete human verification requires unchanged durable evidence and a current receipt check',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'human-verification-evidence-'));try{
  const runId='fixture-human';await mkdir(join(dir,runId));await writeFile(join(dir,runId,'screenshot.jpg'),'blocked form');
  const url='https://jobs.ashbyhq.com/example/123';
  await writeFile(join(dir,'queue.json'),JSON.stringify({jobs:[{job_id:1,id:runId}]}));
  const durable={status:'awaiting_human_submit',canonicalUrl:url,challenge:'captcha',updatedAt:'2026-10-14T02:50:16Z'};
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const proof={resolution:'not_accepted',runId,canonicalUrl:url,reviewedStatus:durable.status,userObservation:'fresh_blank_form',reviewReason:'Saved page shows unresolved challenge before employer acceptance',receiptsCheckedAt:'2026-10-16T04:30:00Z',durableSha256:hash(JSON.stringify(durable)),screenshotSha256:hash('blocked form')};
  const request={receiptFile:join(dir,'receipts.json'),items:[{job_id:1,job:{company:'Example',title:'Engineer',url},durable}]};
  const audit=()=>{const r=spawnSync(process.execPath,['tools/reconcile-help.mjs'],{input:JSON.stringify(request),encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout)[0];};
  const save=()=>writeFile(join(dir,'help-verification-evidence.json'),JSON.stringify({'1':proof}));
  await save();assert.equal(audit().verificationNotAccepted,true);
  proof.receiptsCheckedAt='2026-10-13T00:00:00Z';await save();assert.equal(audit().verificationNotAccepted,false);
  proof.receiptsCheckedAt='2026-10-16T04:30:00Z';await save();durable.status='submitted';assert.equal(audit().verificationNotAccepted,false);
  durable.status='awaiting_human_submit';durable.challenge='different';assert.equal(audit().verificationNotAccepted,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('explicit rejected submissions require matched durable and screenshot evidence, never a missing receipt',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'submission-rejection-evidence-'));try{
  const runId='fixture-rejected';await mkdir(join(dir,runId));await writeFile(join(dir,runId,'screenshot.jpg'),'validation screenshot');
  const url='https://job-boards.greenhouse.io/example/jobs/123456';const hash=value=>createHash('sha256').update(value).digest('hex');
  await writeFile(join(dir,'queue.json'),JSON.stringify({jobs:[{job_id:1,id:runId}]}));
  const durable={status:'submitted_pending_receipt',canonicalUrl:url,submittedAt:'2026-10-15T12:00:00Z'};
  const proof={resolution:'not_accepted',runId,canonicalUrl:url,reviewedStatus:durable.status,durableSha256:hash(JSON.stringify(durable)),screenshotSha256:hash('validation screenshot'),reviewReason:'Saved post-submit page contains an explicit validation error',observedFailure:'validation_error',rejectionText:'Select a country'};
  const request={receiptFile:join(dir,'receipts.json'),items:[{job_id:1,job:{company:'Example',title:'Engineer',url},durable}]};
  const audit=()=>{const r=spawnSync(process.execPath,['tools/reconcile-help.mjs'],{input:JSON.stringify(request),encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout)[0];};
  const save=()=>writeFile(join(dir,'help-verification-evidence.json'),JSON.stringify({'1':proof}));
  await save();assert.equal(audit().verificationNotAccepted,true);
  proof.rejectionText='No receipt was found';await save();assert.equal(audit().verificationNotAccepted,false);
  proof.observedFailure='spam_rejection';proof.rejectionText='We couldn’t submit your application. Your application submission was flagged as possible spam.';await save();assert.equal(audit().verificationNotAccepted,true);
  durable.submittedAt='2026-10-16T12:00:00Z';assert.equal(audit().verificationNotAccepted,false);
  durable.submittedAt='2026-10-15T12:00:00Z';await writeFile(join(dir,runId,'screenshot.jpg'),'changed screenshot');assert.equal(audit().verificationNotAccepted,false);
 }finally{await rm(dir,{force:true,recursive:true});}
});


test('an explicit applicant verification rejection must bind the current attempt, report and unchanged evidence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'reported-verification-rejection-'));try{
  const runId='fixture-current';await mkdir(join(dir,runId));await writeFile(join(dir,runId,'screenshot.jpg'),'last challenge page');
  const url='https://jobs.lever.co/example/fixture-role/apply',hash=v=>createHash('sha256').update(v).digest('hex');
  const durable={status:'submitted_pending_receipt',canonicalUrl:url,updatedAt:new Date(Date.now()-60000).toISOString()};
  await writeFile(join(dir,'queue.json'),JSON.stringify({jobs:[{job_id:1,id:runId}]}));
  const report='I complete the CAPTCHA but the website says unable to verify my application.';
  const proof={resolution:'not_accepted',runId,canonicalUrl:url,reviewedStatus:durable.status,durableSha256:hash(JSON.stringify(durable)),screenshotSha256:hash('last challenge page'),reviewReason:'Applicant explicitly reports employer verification failure',observedFailure:'captcha_verification_rejected',evidenceSource:'applicant_chat',userObservation:'application_verification_failed',reportedAt:new Date().toISOString(),applicantReport:report,applicantReportSha256:hash(report)};
  const request={receiptFile:join(dir,'receipts.json'),items:[{job_id:1,job:{company:'Example',title:'Engineer',url},durable}]};
  const check=async(change={})=>{await writeFile(join(dir,'help-verification-evidence.json'),JSON.stringify({'1':{...proof,...change}}));const r=spawnSync(process.execPath,['tools/reconcile-help.mjs'],{input:JSON.stringify(request),encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout)[0].verificationNotAccepted;};
  assert.equal(await check(),true);
  for(const change of [{runId:'old-run'},{canonicalUrl:url+'other'},{durableSha256:'0'.repeat(64)},{evidenceSource:'inferred'},{reportedAt:'2000-01-01T00:00:00Z'},{applicantReport:'I found no receipt',applicantReportSha256:hash('I found no receipt')},{applicantReportSha256:'0'.repeat(64)}])assert.equal(await check(change),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a spam-flagged rejection is not accepted but never retry-safe (lesson 289)',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spam-flag-evidence-'));try{
  const url='https://jobs.ashbyhq.com/example/1f217a8b-1137-4d72-ae2d-27cd522ef964';
  const rejection={source:'webpage',outcome:'flagged_spam',url,messages:['flagged as possible spam'],invalidFields:[]};
  const request={receiptFile:join(dir,'receipts.json'),items:[{job_id:1,job:{company:'Example',title:'Engineer',url},durable:{status:'verification_not_accepted',canonicalUrl:url,rejection}}]};
  const audit=()=>{const r=spawnSync(process.execPath,['tools/reconcile-help.mjs'],{input:JSON.stringify(request),encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout)[0];};
  let out=audit();assert.equal(out.verificationNotAccepted,false);assert.equal(out.humanOnly,'flagged_spam');assert.equal(out.receipt,null);
  request.items[0].durable.rejection={...rejection,outcome:'rejected',messages:['Cover Letter is required']};
  out=audit();assert.equal(out.verificationNotAccepted,true);assert.equal(out.humanOnly,undefined);
  request.items[0].durable.rejection={...rejection,outcome:'verification_code',messages:['enter the security code']};
  out=audit();assert.equal(out.verificationNotAccepted,true);
  delete request.items[0].durable.rejection;  // older audit record with no reason: Saronic/Crusoe were re-run from these
  out=audit();assert.equal(out.verificationNotAccepted,false);assert.equal(out.humanOnly,'unknown');
 }finally{await rm(dir,{recursive:true,force:true});}
});
