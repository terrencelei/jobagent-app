import { readFile, mkdir, writeFile, rename, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateJob, validatePlan, filterJob, resolveAnswers, fingerprint, assertApproval, capExceeded } from './core.mjs';
import { loadBank, loadAnswers, saveBank, recordApprovals, SHARED } from './companies.mjs';

const [command, jobsPath, profilePath, jobId, planPath] = process.argv.slice(2);
const read = async p => JSON.parse(await readFile(p,'utf8'));
async function main() {
  if (!['queue','pending','record-approval','confirm-receipt','prepare','approve','submit'].includes(command) || !jobsPath || !profilePath) throw new Error('Usage: npm run agent -- queue JOBS PROFILE | pending|record-approval|prepare|approve|submit JOBS PROFILE JOB_ID PLAN [APPROVALS]');
  const jobs = await read(jobsPath), profile = await read(profilePath);
  if (!Array.isArray(jobs)) throw new Error('Jobs must be a JSON array');
  const ids=new Set(); const urls=new Set();
  for (const job of jobs) { validateJob(job); if(ids.has(job.id)||urls.has(job.url)) throw new Error('Duplicate id or URL in queue'); ids.add(job.id); urls.add(job.url); }
  if(command==='queue') { console.log(JSON.stringify(jobs.map(j=>({id:j.id,title:j.title,reviewReasons:filterJob(j,profile.policy)})),null,2)); return; }
  const job = jobs.find(j=>j.id===jobId); if(!job) throw new Error('Unknown job');
  const reasons = filterJob(job,profile.policy); if(reasons.length) throw new Error(`Eligibility review required: ${reasons.join(', ')}`);
  const plan = await read(planPath); validatePlan(plan);
  const bankDir = 'private/companies';
  const {answers: bankAnswers} = await loadAnswers(bankDir, job.company);
  if (command==='confirm-receipt') {
    // The employer's own acknowledgement is the authority, not whatever the page happened to
    // render. Recording it needs evidence that can be checked later.
    const evidence = await read(process.argv[7] ?? (()=>{throw new Error('Pass a receipt evidence JSON file');})());
    if (!evidence.sender || !evidence.receivedAt || !evidence.quote) throw new Error('Receipt evidence needs sender, receivedAt and a quote');
    const statePath=`state/${job.id}.json`;
    let st={}; try { st = await read(statePath); } catch(e) { if(e.code!=='ENOENT') throw e; }
    await writeFile(`${statePath}.tmp`, JSON.stringify({...st, status:'submitted', receiptSource:'mailbox', receiptEvidence:evidence, updatedAt:new Date().toISOString()}, null, 2), {mode:0o600});
    await rename(`${statePath}.tmp`, statePath);
    console.log(`${job.id}: submitted (receipt verified from ${evidence.sender})`);
    // The scraper owns the dashboard, so a confirmed submission has to be reported back or the
    // posting keeps showing as open work. A failed sync must never undo a verified receipt.
    if (job.jobagentId && profile.jobagent?.markAppliedCommand) {
      const {execFile} = await import('node:child_process');
      const {promisify} = await import('node:util');
      const args = profile.jobagent.markAppliedCommand.map(a =>
        a.replace('{jobagentId}', String(job.jobagentId))
         .replace('{notes}', `Submitted via application-agent; receipt from ${evidence.sender} at ${evidence.receivedAt}`));
      try {
        await promisify(execFile)(args[0], args.slice(1), {cwd: profile.jobagent.cwd ?? process.cwd()});
        console.log(`${job.id}: jobagent job ${job.jobagentId} marked applied`);
      } catch (e) { console.error(`${job.id}: receipt recorded, but jobagent sync failed: ${e.message.split('\n')[0]}`); }
    }
    return;
  }
  if (command==='record-approval') {
    const approvals = await read(process.argv[7] ?? (()=>{throw new Error('Pass the approvals JSON file');})());
    // An answer marked shared is filed once and reused for every later employer.
    for (const [target, subset] of [[SHARED, approvals.filter(a=>a.shared===true)], [job.company, approvals.filter(a=>a.shared!==true)]]) {
      if (!subset.length) continue;
      await saveBank(bankDir, target, recordApprovals(await loadBank(bankDir, target), subset, job.id));
      console.log(`${target}: recorded ${subset.length} approved answer(s)`);
    }
    return;
  }
  // An employer cap is invisible at submission time, so it has to be checked before the click.
  if (['prepare','approve','submit'].includes(command)) {
    const { readdir } = await import('node:fs/promises');
    let files = [];
    try { files = (await readdir('state')).filter(f => f.endsWith('.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const submissions = [];
    for (const f of files) {
      let st; try { st = await read(`state/${f}`); } catch { continue; }
      // An application the employer threw out for exceeding its own cap still consumed a slot,
      // so it counts here exactly like one they accepted.
      if (st.company && st.submittedAt && ['submitted','submitted_pending_receipt','declined_application_limit'].includes(st.status)) submissions.push(st);
    }
    const hit = capExceeded(job.company, profile.policy, submissions);
    if (hit) throw new Error(`${hit.company} accepts ${hit.max} applications per ${hit.days} days and ${hit.counted} are already in; next eligible ${hit.nextEligible}`);
  }
  const {answers, pending} = resolveAnswers(plan, profile, bankAnswers);
  if (command==='pending') { console.log(JSON.stringify({job:{id:job.id,company:job.company,title:job.title,url:job.url}, pending},null,2)); return; }
  // Nothing is sent to an employer until the user has seen the wording for this company.
  if (pending.length) throw new Error(`${pending.length} answer(s) await your approval (${pending.map(p=>p.key).join(', ')}); run: npm run agent -- pending ...`);
  const resumePath=resolve(profile.resumePath);
  const digest=fingerprint(job,plan,answers,await readFile(resumePath));
  await mkdir('state',{recursive:true,mode:0o700});
  const lock=await open(`state/${job.id}.lock`,'wx',0o600);
  try {
    const statePath=`state/${job.id}.json`;
    let state={status:'new'};
    try { state=await read(statePath); } catch(e) { if(e.code!=='ENOENT')throw e; }
    const save=async(status,extra={})=>{const {error:_prior,...kept}=state;state={...kept,...extra,status,company:job.company,fingerprint:digest,updatedAt:new Date().toISOString()};if(status==='submitted'||status==='submitted_pending_receipt')state.submittedAt=state.submittedAt??new Date().toISOString();await writeFile(`${statePath}.tmp`,JSON.stringify(state,null,2),{mode:0o600});await rename(`${statePath}.tmp`,statePath);console.log(`${job.id}: ${status}`);};
    if(['submitted','submitted_pending_receipt','submitting','submission_unknown','needs_human_verification','awaiting_verification_code','awaiting_human_submit'].includes(state.status)) throw new Error(`Existing ${state.status} application: reconcile before any retry`);
    if(command==='approve') {
      if(state.status!=='prepared'||state.fingerprint!==digest)throw new Error('Prepare and review this exact package first');
      await save('approved');return;
    }
    if(command==='submit')assertApproval(state,digest);
    const artifactDir=`artifacts/${job.id}`;await mkdir(artifactDir,{recursive:true,mode:0o700});
    await writeFile(`${artifactDir}/review.json`,JSON.stringify({job,answers,resumePath,fingerprint:digest},null,2),{mode:0o600});
    const {runBrowser}=await import('./browser.mjs');
    try { await runBrowser({job,plan,answers,resumePath,artifactDir,submit:command==='submit',beforeSubmit:()=>save('submitting'),saveStatus:save}); }
    catch(e){await save(['submitting','awaiting_verification_code','submitted_pending_receipt','needs_human_verification'].includes(state.status)?'submission_unknown':'preparation_failed',{error:e.message});throw e;}
  } finally { await lock.close();await unlink(`state/${job.id}.lock`); }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
