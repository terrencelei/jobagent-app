import {createHash, timingSafeEqual, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, open, link, unlink} from 'node:fs/promises';
import {join} from 'node:path';
export const digest = x => createHash('sha256').update(typeof x === 'string' || Buffer.isBuffer(x) ? x : JSON.stringify(x)).digest('hex');
export const readJSON = async p => JSON.parse(await readFile(p,'utf8'));
export async function atomicJSON(path,value){await mkdir(join(path,'..'),{recursive:true,mode:0o700});const temp=path+'.tmp';await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(temp,path);}
export function validToken(given,want){if(typeof given!=='string'||!want)return false;const a=Buffer.from(given),b=Buffer.from(want);return a.length===b.length && timingSafeEqual(a,b);}
export function publicRequest(config){return {id:config.id,version:config.version,expiresAt:config.expiresAt,jobs:config.jobs.map(j=>({id:j.job.id,company:j.job.company,title:j.job.title,url:j.job.url,summary:j.summary,notes:j.notes,controls:j.controls,fixed:j.fixed}))};}
export function validateApproval(config,body,now=Date.now()){
  if(now>new Date(config.expiresAt).getTime())throw Error('This approval link has expired.');
  if(body?.version!==config.version || body?.requestId!==config.id)throw Error('The application package changed. Reload and review it again.');
  if(body.confirmed!==true)throw Error('Explicit confirmation is required.');
  if(!Array.isArray(body.applications)||body.applications.length!==config.jobs.length)throw Error('Choose a decision for every role.');
  const seen=new Set();
  const applications=body.applications.map(a=>{
    const j=config.jobs.find(x=>x.job.id===a.jobId);
    if(!j||seen.has(a.jobId))throw Error('Unknown or repeated job.');seen.add(a.jobId);
    if(/google/i.test(j.job.company))throw Error('Google is paused.');
    if(!['approve_submission','hold'].includes(a.decision))throw Error('Choose approve or hold for every role.');
    if(typeof a.notes!=='string'||a.notes.length>4000)throw Error('Invalid notes.');
    if(!a.answers||typeof a.answers!=='object'||Array.isArray(a.answers))throw Error('Invalid answers.');
    for(const key of Object.keys(a.answers))if(!j.controls.some(c=>c.key===key))throw Error('Unrecognised answer field.');
    const answers={};
    for(const c of j.controls){
      const v=a.answers[c.key];
      if(typeof v!=='string'||v.length>(c.maxLength??2000))throw Error('Invalid answer: '+c.label);
      if(a.decision==='approve_submission' && c.required && !v.trim())throw Error('Please answer: '+c.label);
      if(v && c.options && !c.options.includes(v))throw Error('Invalid choice: '+c.label);
      if(c.readOnly && v!==c.draft)throw Error('Saved answer changed; describe the correction in notes.');
      answers[c.key]=v;
    }
    if(a.decision==='approve_submission'){
      if(j.salaryException && answers._salaryException!=='Yes, for this role only')throw Error('Approve the salary exception or hold this role.');
      if(j.sourceDetails && ['Other','Industry Conference'].includes(answers[j.sourceDetails.sourceKey]) && !answers[j.sourceDetails.detailKey]?.trim())throw Error('Add details for how you heard about this role.');
    }
    return {jobId:a.jobId,decision:a.decision,answers,notes:a.notes.trim(),status:a.decision==='hold'?'held':a.notes.trim()?'needs_review':'queued'};
  });
  return {requestId:config.id,version:config.version,confirmed:true,approvedAt:new Date(now).toISOString(),applications};
}
export async function persistApproval(dir,record){
  await mkdir(dir,{recursive:true,mode:0o700});
  // A link is one decision package, not a reusable job-submission endpoint.
  // Exclusive creation makes concurrent clicks and HTTP retries idempotent.
  const path=join(dir,'approval.json'),temp=join(dir,'approval-'+randomUUID()+'.tmp');
  const file=await open(temp,'wx',0o600);
  try{await file.writeFile(JSON.stringify(record,null,2)+'\n');await file.sync();}finally{await file.close();}
  try{await link(temp,path);return {created:true,record};}
  catch(e){if(e.code==='EEXIST')return {created:false,record:await readJSON(path)};throw e;}
  finally{await unlink(temp);}

}
export function initialStatus(record){return {approvedAt:record.approvedAt,version:record.version,applications:record.applications.map(a=>({jobId:a.jobId,status:a.status,detail:a.status==='needs_review'?'Your additional instructions need review before submission.':a.status==='held'?'You chose to hold this application.':'Approved. Waiting for the application runner.'}))};}
