// Resume an explicitly approved, verification-blocked form without deleting its prior state.
import {readFile,mkdir,open,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {answersFor,fingerprint,assertHumanHandoff} from '../src/core.mjs';
import {loadAnswers} from '../src/companies.mjs';
import {atomicJSON} from '../src/approval-portal.mjs';
const [jobsPath,profilePath,id,planPath]=process.argv.slice(2);
if(!jobsPath||!profilePath||!id||!planPath)throw Error('Usage: node tools/handoff-approved.mjs JOBS PROFILE JOB_ID PLAN');
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const jobs=await read(jobsPath),profile=await read(profilePath),plan=await read(planPath),job=jobs.find(j=>j.id===id);
if(!job||!/^[a-zA-Z0-9_-]+$/.test(id)||/google/i.test(job.company))throw Error('Invalid or paused job');
const statePath=`state/${id}.json`,prior=await read(statePath);

const bank=(await loadAnswers('private/companies',job.company)).answers,answers=answersFor(plan,profile,bank),resumePath=resolve(profile.resumePath);
const digest=fingerprint(job,plan,answers,await readFile(resumePath));
assertHumanHandoff(prior,digest);
const lock=await open(`state/${id}.lock`,'wx',0o600);
const dir=`artifacts/${id}/handoff-${Date.now()}`;await mkdir(dir,{recursive:true,mode:0o700});
await atomicJSON(join(dir,'prior-state.json'),prior);
let state={...prior,handoffStartedAt:new Date().toISOString(),priorStatePath:join(dir,'prior-state.json')};
async function saveStatus(status,extra={}){state={...state,...extra,status,updatedAt:new Date().toISOString()};await atomicJSON(statePath,state);console.log(`${id}: ${status}`);}
try{
 process.env.APPLICATION_AGENT_HEADED='1';process.env.APPLICATION_AGENT_HANDOFF='1';process.env.APPLICATION_AGENT_CHANNEL='chrome';process.env.APPLICATION_AGENT_PROFILE_DIR=resolve('private/browser-profile');
 const {runBrowser}=await import('../src/browser.mjs');
 await runBrowser({job,plan,answers,resumePath,artifactDir:dir,submit:false,beforeSubmit:async()=>{throw Error('Automatic submission is disabled in human handoff.');},saveStatus});
}catch(e){await saveStatus('needs_human_verification',{handoffError:e.message});throw e;}
finally{await lock.close();await unlink(`state/${id}.lock`);}
