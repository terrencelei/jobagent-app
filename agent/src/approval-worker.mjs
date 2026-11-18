import {readFile,writeFile,mkdir,open,unlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {atomicJSON,readJSON,digest,initialStatus} from './approval-portal.mjs';
const terminalGuard=new Set(['submitted','submitted_pending_receipt','submitting','submission_unknown','needs_human_verification','awaiting_verification_code','awaiting_human_submit']);
export function materialize(config,approved){
  const entry=config.jobs.find(j=>j.job.id===approved.jobId);
  if(!entry || approved.decision!=='approve_submission'||approved.notes || /google/i.test(entry.job.company))throw Error('This role is not approved for automatic submission.');
  const profile=structuredClone(entry.profile),plan=structuredClone(entry.plan);
  profile.answers={...profile.answers,...entry.answers};
  for(const c of entry.controls){if(c.key.startsWith('_'))continue;profile.answers[c.key]=approved.answers[c.key];}
  // Freeze the exact approved answers into a job-local profile. The shared answer bank
  // must not change what this approval authorised while the queue is running.
  for(const field of plan.fields){if(field.source==='approval'){field.approvalQuestion=field.question;delete field.source;}}
  if(entry.salaryException){if(approved.answers._salaryException!=='Yes, for this role only')throw Error('Salary exception is not approved.');profile.policy.minimumBaseSalary=entry.job.salary.min;}
  if(entry.sourceDetails && !['Other','Industry Conference'].includes(profile.answers[entry.sourceDetails.sourceKey]))plan.fields=plan.fields.filter(f=>f.key!==entry.sourceDetails.detailKey);
  // Optional explanations were explicitly reviewed as blank, not silently ignored.
  if(approved.answers._optional && approved.answers._optional!=='Leave inapplicable explanations blank')throw Error('Optional explanations need review.');
  profile.approvalEvidence={requestId:config.id,version:config.version,jobId:entry.job.id};
  return {job:entry.job,profile,plan};
}
export async function runCommand(args,cwd,logPath){
  const file=await open(logPath,'a',0o600);
  try{await new Promise((resolvePromise,reject)=>{
    const child=spawn(process.execPath,args,{cwd,env:{...process.env,APPLICATION_AGENT_HANDOFF:'0'},stdio:['ignore',file.fd,file.fd]});
    child.on('error',reject);child.on('exit',(code,signal)=>code===0?resolvePromise():reject(Error('Application step stopped ('+(signal||code)+'). See local run log.')));
  });}finally{await file.close();}
}
export function createWorker(config,{run=runCommand}={}){
  let busy=false;
  const dir=config.storageDir,statusPath=join(dir,'status.json');
  const state=async id=>readJSON(join(config.repoDir,'state',id+'.json')).catch(e=>{if(e.code==='ENOENT')return {};throw e;});
  async function tick(){
    if(busy)return;busy=true;let globalLock;
    try{
      try{await readFile(join(dir,'armed'));}catch(e){if(e.code==='ENOENT')return;throw e;}
      let record;try{record=await readJSON(join(dir,'approval.json'));}catch(e){if(e.code==='ENOENT')return;throw e;}
      if(record.version!==config.version)throw Error('Approval package version mismatch.');
      let status=await readJSON(statusPath).catch(e=>{if(e.code==='ENOENT')return initialStatus(record);throw e;});
      for(const row of status.applications){
        if(row.status!=='queued')continue;
        const approved=record.applications.find(a=>a.jobId===row.jobId);
        const set=async(s,detail)=>{row.status=s;row.detail=detail;row.updatedAt=new Date().toISOString();await atomicJSON(statusPath,status);};
        try{
          const existing=await state(row.jobId);
          if(terminalGuard.has(existing.status)){
            await set(existing.status==='submitted'&&existing.receiptSource!=='mailbox'?'submitted_pending_receipt':existing.status,'An existing submission or verification step must be reconciled; no duplicate was sent.');continue;
          }
          try{globalLock=await open(join(config.repoDir,'state','approval-runner.lock'),'wx',0o600);}catch(e){if(e.code==='EEXIST'){await set('blocked','Another application runner or an interrupted run holds the queue lock.');continue;}throw e;}
          const entry=config.jobs.find(j=>j.job.id===row.jobId);
          if(digest(await readFile(resolve(config.repoDir,entry.profile.resumePath)))!==entry.resumeDigest)throw Error('The resume changed after this approval form was created.');
          const pkg=materialize(config,approved),runDir=join(dir,'runs',row.jobId);await mkdir(runDir,{recursive:true,mode:0o700});
          const jobs=join(runDir,'jobs.json'),profile=join(runDir,'profile.json'),plan=join(runDir,'plan.json');
          await atomicJSON(jobs,[pkg.job]);await atomicJSON(profile,pkg.profile);await atomicJSON(plan,pkg.plan);
          await atomicJSON(join(runDir,'approval-evidence.json'),{...approved,approvedAt:record.approvedAt,version:record.version});
          await set('preparing','Approved. Verifying the form and original resume before submission.');
          const base=[jobs,profile,row.jobId,plan],log=join(runDir,'runner.log');
          await run(['src/cli.mjs','prepare',...base],config.repoDir,log);
          // Validate the prepared package, not merely a zero exit code.
          const prepared=await state(row.jobId);if(prepared.status!=='prepared')throw Error('The form did not reach a verified prepared state.');
          const review=await readJSON(join(config.repoDir,'artifacts',row.jobId,'review.json'));
          for(const f of pkg.plan.fields)if(JSON.stringify(review.answers[f.key])!==JSON.stringify(pkg.profile.answers[f.key]))throw Error('Prepared answers differ from approval.');
          await run(['src/cli.mjs','approve',...base],config.repoDir,log);
          await set('submitting','Submission in progress using your approved responses.');
          await run(['src/cli.mjs','submit',...base],config.repoDir,log);
          const end=await state(row.jobId);
          const final=end.status==='submitted'&&end.receiptSource!=='mailbox'?'submitted_pending_receipt':end.status;
          await set(final||'submission_unknown',final==='submitted_pending_receipt'?'The employer page acknowledged the application. Waiting for mailbox confirmation.':final==='needs_human_verification'?'The employer requires human verification. Your answers are saved.':'The application runner finished; status reflects its verified result.');
        }catch(e){
          const st=await state(row.jobId).catch(()=>({}));
          const s=terminalGuard.has(st.status)?(st.status==='submitting'?'submission_unknown':st.status):'blocked';
          await set(s,e.message);
        }finally{if(globalLock){await globalLock.close();globalLock=null;await unlink(join(config.repoDir,'state','approval-runner.lock')).catch(()=>{});}}
      }
    }finally{busy=false;}
  }
  async function recover(){
    let status;try{status=await readJSON(statusPath);}catch(e){if(e.code==='ENOENT')return;throw e;}
    for(const row of status.applications)if(['preparing','submitting','awaiting_verification_code'].includes(row.status)){row.status='interrupted';row.detail='The runner restarted during this application. Check employer status before retrying.';}
    await atomicJSON(statusPath,status);
  }
  return {tick,recover};
}
