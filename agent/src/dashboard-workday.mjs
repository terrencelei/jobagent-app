// Runs a Workday posting for the JobAgent dashboard. Workday is a signed-in wizard that
// tools/workday-run.mjs drives the wizard and consults the selected CLI for unknown questions: it hands
// the run his approved answers, starts workday-run, mirrors its progress and newest screenshot into
// the dashboard's RUN_DIR, and maps where it stopped onto the dashboard's statuses.
//
//   needs_approval      questions nobody has answered yet; they appear on the approvals page
//   ready_to_submit     the review page read back cleanly; he approves, and a second run submits
//   needs_verification  Workday emailed a link the run could not find in his mailbox; he pastes it on the approvals page
//   blocked             sign-in or a step failed; the reason says what to do
//
// Usage: node src/dashboard-workday.mjs RUN_DIR
import {readFile, readdir, stat, copyFile, writeFile, rename} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {learnApprovals,placeholderAnswer} from './companies.mjs';
import {fetchApplicationReceipt} from './application-receipt.mjs';
import {verifiedWebpageAcceptance} from './application-acceptance.mjs';
import {execCLI} from './dashboard-worker.mjs';
import {helperAgent} from './model-fallback.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = async (path, fallback) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (fallback !== undefined) return fallback; throw e; } };
const atomic = async (path, value) => { await writeFile(path + '.tmp', JSON.stringify(value, null, 2), {mode: 0o600}); await rename(path + '.tmp', path); };

export function questionsFrom(request) {
  return (request?.questions ?? []).map(q => ({
    id: q.question, label: q.question, required: Boolean(q.required), draft: q.draft ?? undefined, note: q.note ?? undefined,
    employerRequired:q.employerRequired, approvalReason:q.approvalReason,
    maxWords: q.maxWords ?? undefined, options: q.options?.length ? q.options : q.kind === 'checkbox' ? ['Yes', 'No'] : undefined,
    type: q.options?.length || q.kind === 'checkbox' ? 'select' : q.kind === 'textarea' ? 'textarea' : 'text',
  }));
}

export function outcome(runState, approval) {
  const reason = runState.reason ?? '';
  // Keep the queue's outage marker at the start; wrapping it as a sign-in
  // failure would lose employer cooldown and ask for credentials unnecessarily.
  if (['blocked','needs_account','throttled'].includes(runState.status) && reason.startsWith('Site unavailable:'))
    return {status:'blocked',phase:'blocked',message:reason};
  if (reason.startsWith('Posting unavailable: employer reports that this job page no longer exists')) return {status:'skipped', phase:'skipped', posting_unavailable:true, message:reason};
  switch (runState.status) {
    case 'needs_approval': return {status: 'needs_approval', phase: 'needs_approval', questions: questionsFrom(approval),
      message: `${approval?.questions?.length ?? 0} new question(s) on ${approval?.step ?? 'the application'} flagged for your approval. Moving on to the next role.`};
    case 'at_review': return {status: 'ready_to_submit', phase: 'ready_to_submit', message: 'Every step is filled and the review page read back cleanly. Approve to submit.'};
    case 'submission_unknown': return {status:'submission_unknown',phase:'receipt',submission_attempted:true,message:'Workday submission outcome is uncertain. Check the employer receipt before retrying.'};
    case 'submitted': return verifiedWebpageAcceptance(runState.webpageEvidence,{id:runState.webpageEvidence?.jobId,company:runState.webpageEvidence?.company,url:runState.canonicalUrl}) ? {status:'completed',phase:'completed',submitted:true,receiptSource:'webpage',receipt:runState.webpageEvidence,webpageEvidence:runState.webpageEvidence,message:'Employer webpage confirmed receipt; application completed'} : {status: 'submitted_pending_receipt', phase: 'receipt', message: 'Submitted on Workday. Confirm the employer acknowledgement.'};
    case 'needs_verification': return {status: 'needs_verification', phase: 'needs_verification', message: 'Workday emailed you a verification link that the run could not find in your mailbox. Paste it on the approvals page to continue.'};
    // The reason starts with "Rate-limited", which tells the JobAgent queue to cool the role down.
    case 'throttled': return {status: 'blocked', phase: 'blocked', message: reason};
    case 'needs_cap_approval': return {status: 'needs_cap_approval', phase: 'needs_cap_approval', cap: runState.cap,
      message: `The employer limits applications: "${reason}" Waiting for your approval before applying there.`};
    case 'needs_account': return {status: 'blocked', phase: 'blocked', message: `Workday sign-in: ${reason}`};
    default: return {status: 'blocked', phase: 'blocked', message: reason ? `Workday stopped: ${reason}` : 'Workday stopped without a reason. Check the screenshot.'};
  }
}

export async function runWorkday(runDir, {spawnImpl = spawn, root = ROOT} = {}) {
  runDir = resolve(runDir);
  const request = await readJSON(join(runDir, 'request.json'));
  const {job} = request;
  const jobId = `jobagent-${String(job.id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const events = [], startedAt = new Date().toISOString();
  let state = {status: 'running', phase: 'workday', message: request.submit ? 'Submitting on Workday' : 'Opening Workday', questions: [], events, usage: {}};
  const save = async extra => { state = {...state, ...extra, events: events.slice(-80), updated_at: new Date().toISOString()}; await atomic(join(runDir, 'state.json'), state); };
  const event = async (message, extra = {}) => { events.push({time: new Date().toISOString(), message}); await save({message, ...extra}); };

  const approved = (request.approvedAnswers ?? []).filter(a => a?.question && String(a.answer ?? '').trim()&&!placeholderAnswer(a.answer));
  if (approved.length) {
    const bankDir = join(dirname(resolve(request.profilePath)), 'companies');
    // Saved for this employer, and learned for every employer when the answer is not specific to it.
    const learned = await learnApprovals(bankDir, job.company, approved.map(a => ({...a, answer: String(a.answer)})), jobId);
    await event(`Saved ${learned.own} approved answer(s) for ${job.company}${learned.shared ? `; ${learned.shared} learned for every employer` : ''}`);
  }
  if (request.verifyLink) await writeFile(join(root, 'state', `${jobId}.verifylink`), String(request.verifyLink), {mode: 0o600});
  await atomic(join(runDir, 'jobs.json'), [{...job, id:jobId}]);
  await event(request.submit ? 'Submitting the approved Workday application once' : 'Signing in to Workday');

  // Pin the exact resume selected by JobAgent; a relative profile path belongs
  // to the application-agent root, not to this run directory.
  const profile=await readJSON(resolve(request.profilePath));
  profile.resumePath=resolve(root,request.resumePath??profile.resumePath);
  const resumeHash=createHash('sha256').update(await readFile(profile.resumePath)).digest('hex');
  await atomic(join(runDir,'effective-profile.json'),profile);
  await save({resumePath:profile.resumePath,resumeHash});
  const args = [join(root, 'tools/workday-run.mjs'), join(runDir, 'jobs.json'), join(runDir,'effective-profile.json'), jobId];
  if (request.submit === true || request.autoSubmit === true) args.push('--submit');
  const liveFrame = join(runDir, 'screenshot.jpg');
  const child = spawnImpl(process.execPath, args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, JOBAGENT_LIVE_FRAME: liveFrame, JOBAGENT_QUESTION_AGENT: join(runDir, 'request.json')}});
  let stopping = false;
  const onLine = line => { const text = line.trim(); if (text && !/password/i.test(text)) event(text.slice(0, 300)).catch(() => {}); };
  let buffer = '';
  child.stdout?.on('data', d => { buffer += d; const lines = buffer.split('\n'); buffer = lines.pop(); lines.forEach(onLine); });
  child.stderr?.on('data', d => onLine(String(d).split('\n')[0]));
  // workday-run streams the page live into screenshot.jpg; a step snapshot is copied in only
  // when no live frame has arrived for a while (for example if the screencast is unavailable).
  const artifacts = join(root, 'artifacts', jobId);
  let newest = 0, lastUsage = '';
  const mirror = async () => {
    try {
      const liveAge = Date.now() - (await stat(liveFrame).then(s => s.mtimeMs, () => 0));
      for (const name of liveAge > 5000 ? await readdir(artifacts) : []) {
        if (!name.endsWith('.png')) continue;
        const {mtimeMs} = await stat(join(artifacts, name));
        if (mtimeMs > newest) { newest = mtimeMs; await copyFile(join(artifacts, name), liveFrame); }
      }
    } catch {}
    // The model calls workday-run made (tools/workday-run.mjs meters them): the cost page reads state.model_usage.
    try {
      const metered = await readJSON(join(artifacts, 'model-usage.json'), null);
      const text = JSON.stringify(metered ?? {});
      if (metered?.model_usage && Object.keys(metered.model_usage).length && text !== lastUsage) {
        lastUsage = text; await save({usage: metered.usage, model_usage: metered.model_usage});
      }
    } catch {}
    try {
      const cmd = await readJSON(join(runDir, 'commands.json'), null);
      if (cmd?.action === 'stop' && !stopping) { stopping = true; child.kill('SIGTERM'); }
    } catch {}
  };
  const timer = setInterval(mirror, 1500);
  const stop = () => { stopping = true; child.kill('SIGTERM'); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const code = await new Promise(r => child.on('close', r));
  clearInterval(timer); await mirror();
  process.off('SIGTERM', stop); process.off('SIGINT', stop);
  if (stopping) { await event('Stopped by applicant', {status: 'stopped', phase: 'stopped'}); return; }
  // Only trust a state this run wrote; an older one would describe a previous attempt.
  let runState = await readJSON(join(root, 'state', `${jobId}.json`), {});
  if (!runState.updatedAt || runState.updatedAt < startedAt) runState = {};
  const approval = runState.status === 'needs_approval' ? await readJSON(join(artifacts, 'approval-request.json'), null) : null;
  const result = outcome(runState.status ? runState : {status: 'blocked', reason: `workday-run exited with code ${code}`}, approval);
  await event(result.message, result);
  if(runState.status==='submitted'&&result.status!=='completed'){
    await event('Checking the employer acknowledgement in your mailbox', {phase:'receipt'});
    const receipt=await fetchApplicationReceipt(job,{email:profile.answers?.email,after:runState.submittedAt,...helperAgent({engine:request.engine,command:request.command,model:request.model}),execImpl:execCLI});
    if(receipt){
      runState={...runState,receiptSource:'mailbox',receiptEvidence:receipt};
      await atomic(join(root,'state',`${jobId}.json`),runState);
      await event('Employer receipt verified; application completed',{status:'completed',phase:'completed',submitted:true,receipt,receiptSource:'mailbox'});
    }else await event('Submitted on Workday; employer email has not been verified yet',{status:'submitted_pending_receipt',phase:'receipt'});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node src/dashboard-workday.mjs RUN_DIR');
  await runWorkday(process.argv[2]);
}
