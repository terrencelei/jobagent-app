// Evidence-only audit. The queue owns all decisions and mutations.
import {readFile} from 'node:fs/promises';
import {verifiedReceipt} from '../src/application-receipt.mjs';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
let input='';for await(const chunk of process.stdin)input+=chunk;
const request=JSON.parse(input);
let receipts=[];try{receipts=JSON.parse(await readFile(request.receiptFile,'utf8'));}catch{}
let reviewed={},queue={};
try{reviewed=JSON.parse(await readFile(join(dirname(request.receiptFile),'help-verification-evidence.json'),'utf8'));queue=JSON.parse(await readFile(join(dirname(request.receiptFile),'queue.json'),'utf8'));}catch{}
const result=await Promise.all(request.items.map(async item=>{
 const evidence=[item.durable?.receiptEvidence,...receipts].filter(Boolean);
 const receipt=evidence.map(r=>verifiedReceipt(r,item.job)).find(Boolean);
 let reviewedGate=false;
 const proof=reviewed[String(item.job_id)];
 const current=queue.jobs?.find(j=>j.job_id===item.job_id);
 const reviewedCodeGate=item.durable?.status==='awaiting_verification_code';
 const reviewedIncomplete=['needs_human_verification','awaiting_human_submit'].includes(item.durable?.status)&&proof?.reviewedStatus===item.durable.status&&proof?.userObservation==='fresh_blank_form'&&proof?.reviewReason?.trim()&&Date.parse(proof.receiptsCheckedAt)>=Date.parse(item.durable.updatedAt)&&proof?.durableSha256===createHash('sha256').update(JSON.stringify(item.durable)).digest('hex');
 const explicitFailure=proof?.observedFailure==='validation_error'&&/\b(?:select a country|(?:is|are) required|this field is required|please (?:select|enter|complete))\b/i.test(proof.rejectionText||'')||proof?.observedFailure==='spam_rejection'&&/\b(?:couldn[’']t|could not|unable to|failed to) submit\b/i.test(proof.rejectionText||'')&&/\b(?:spam|rejected)\b/i.test(proof.rejectionText||'');
 // An applicant's explicit report of the employer's verification rejection is
 // positive failure evidence. Bind it to this exact attempt; absence of mail or
 // a fresh form alone never authorizes a repeat submission.
 const reportTime=Date.parse(proof?.reportedAt);
 const reportedRejection=proof?.observedFailure==='captcha_verification_rejected'&&proof?.evidenceSource==='applicant_chat'&&proof?.userObservation==='application_verification_failed'&&/\bunable to verify (?:my|your|the) application\b/i.test(proof.applicantReport||'')&&proof?.applicantReportSha256===createHash('sha256').update(proof.applicantReport||'').digest('hex')&&Number.isFinite(reportTime)&&reportTime>=Date.parse(item.durable.updatedAt||item.durable.submittedAt)&&reportTime<=Date.now()+300000;
 const reviewedRejection=['submitted','submitted_pending_receipt','submission_unknown'].includes(item.durable?.status)&&proof?.reviewedStatus===item.durable.status&&proof?.reviewReason?.trim()&&(explicitFailure||reportedRejection)&&proof?.durableSha256===createHash('sha256').update(JSON.stringify(item.durable)).digest('hex');
 if(proof?.resolution==='not_accepted'&&proof.runId===current?.id&&proof.canonicalUrl===item.durable?.canonicalUrl&&(reviewedCodeGate||reviewedIncomplete||reviewedRejection)){
  const bytes=await readFile(join(dirname(request.receiptFile),current.id,'screenshot.jpg')).catch(()=>null);
  reviewedGate=!!bytes&&createHash('sha256').update(bytes).digest('hex')===proof.screenshotSha256;
 }
 // Only a recorded form-error or emailed-code rejection is safe to rerun. Ashby's "flagged as possible
 // spam" is a risk-score wall with nothing to fix (lessons 23/40/235/289): the same browser is flagged
 // again on every retry. A record with no rejection reason (older audits) is not provably safe either.
 const outcome=item.durable?.rejection?.outcome;
 const retrySafe=['rejected','verification_code'].includes(outcome);
 const humanOnly=!receipt&&item.durable?.status==='verification_not_accepted'&&!retrySafe&&!reviewedGate?(outcome||'unknown'):null;
 return {job_id:item.job_id,receipt:receipt??null,
  verificationNotAccepted:!receipt&&!humanOnly&&((item.durable?.status==='verification_not_accepted'&&retrySafe)||reviewedGate),
  ...(humanOnly?{humanOnly}:{}),
  ...(reviewedGate?{verificationEvidence:proof}:{})};
}));
console.log(JSON.stringify(result));
