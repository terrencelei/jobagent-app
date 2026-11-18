import {readFile,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchApplicationReceipt} from '../src/application-receipt.mjs';
import {webpageAcceptance,verifiedWebpageAcceptance} from '../src/application-acceptance.mjs';
import {execCLI} from '../src/dashboard-worker.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=async path=>JSON.parse(await readFile(path,'utf8'));

// Only an explicitly supplied operator-reviewed record may transcribe historical
// screenshots. Bind it to this exact attempt and the bytes still on disk.
export async function reviewedWebpageAcceptance(record,{run,request,durable,state}) {
 const screenshot=join(resolve(run),'screenshot.jpg');
 if(!record||record.runId!==basename(resolve(run))||String(record.jobId)!==String(request.job.id)||
  record.canonicalUrl!==request.job.url||durable.canonicalUrl!==request.job.url||
  record.submittedAt!==durable.submittedAt||!durable.submittedAt||
  record.durableSha256!==createHash('sha256').update(JSON.stringify(durable)).digest('hex')||
  resolve(record.screenshotPath||'.')!==screenshot||
  !/^[a-f0-9]{64}$/.test(record.screenshotSha256||''))return null;
 const bytes=await readFile(screenshot);
 if(createHash('sha256').update(bytes).digest('hex')!==record.screenshotSha256)return null;
 // A posting on one host can be applied for on its redirect host (ArcBest 12717: arcbest.avature.net posting,
 // careers.arcb.com application and Success page). Only the worker's own last observed URL (state.url) may
 // vouch for that host, and only when the reviewed record names exactly that page.
 const observed=typeof state?.url==='string'&&state.url===record.url?record.url:request.job.url;
 const evidence=webpageAcceptance({text:record.text,url:record.url,submittedFromUrl:observed,
  job:request.job,submittedAt:record.submittedAt,now:record.confirmedAt});
 return evidence?{...evidence,screenshotPath:screenshot,screenshotSha256:record.screenshotSha256,
  reviewedRunId:record.runId}:null;
}

export async function verifyRun(run,{reviewedPath}={}) {
 run=resolve(run);
 const state=await read(join(run,'state.json'));
 if(!['submitted_pending_receipt','submission_unknown'].includes(state.status)&&!(['needs_human','blocked','failed','interrupted'].includes(state.status)&&state.submission_attempted)&&!(state.status==='needs_human'&&state.phase==='human_submit')){
  console.log('Receipt reconciliation is unnecessary');return 0;
 }
 const request=await read(join(run,'request.json'));
 const jobId=`jobagent-${String(request.job.id).replace(/[^a-zA-Z0-9_-]/g,'_')}`;
 const jobPath=join(root,'state',jobId+'.json');const durable=await read(jobPath);
 if(!['submitted','submitted_pending_receipt','submission_unknown','submitting','awaiting_human_submit','awaiting_verification_code','needs_human_verification','verification_not_accepted'].includes(durable.status)||durable.canonicalUrl&&durable.canonicalUrl!==request.job.url)throw Error('No matching submission attempt exists');
 let receipt=[state.webpageEvidence,state.receipt,durable.webpageEvidence,durable.receiptEvidence]
  .map(value=>verifiedWebpageAcceptance(value,request.job)).find(Boolean);
 if(!receipt&&reviewedPath){
  receipt=await reviewedWebpageAcceptance(await read(reviewedPath),{run,request,durable,state});
  if(!receipt)throw Error('Reviewed webpage evidence does not match this submission attempt');
 }
 if(!receipt){
  const profile=await read(request.profilePath);
  receipt=await fetchApplicationReceipt(request.job,{email:profile.answers?.email,after:durable.submittedAt??durable.updatedAt??state.updated_at,engine:request.engine,command:request.command,model:request.model,execImpl:execCLI,log:console.log,onDiagnostics:data=>writeFile(join(run,'receipt-diagnostics.json'),JSON.stringify(data),{mode:0o600})});
 }
 if(!receipt){console.log('No verified acknowledgement yet');return 2;}
 const source=receipt.source==='webpage'?'webpage':'mailbox';
 const atomic=async(path,data)=>{await writeFile(path+'.receipt-tmp',JSON.stringify(data,null,2),{mode:0o600});await rename(path+'.receipt-tmp',path);};
 await atomic(jobPath,{...durable,status:'submitted',receiptSource:source,receiptEvidence:receipt,updatedAt:new Date().toISOString()});
 await atomic(join(run,'state.json'),{...state,status:'completed',phase:'completed',submitted:true,receiptSource:source,receipt,updated_at:new Date().toISOString(),message:`Employer ${source==='webpage'?'webpage acknowledgement':'receipt'} verified; application completed`});
 console.log('Employer acknowledgement verified; application completed');return 0;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);const reviewed=args.indexOf('--reviewed-webpage');
 if(!args[0]||(reviewed>=0&&!args[reviewed+1]))throw Error('Usage: verify-application-receipt.mjs RUN [--reviewed-webpage EVIDENCE.json]');
 process.exitCode=await verifyRun(args[0],{reviewedPath:reviewed>=0?args[reviewed+1]:undefined});
}
