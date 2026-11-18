// Free reCAPTCHA (v2 and Enterprise) solving through the accessibility audio challenge,
// transcribed on this Mac by whisper.cpp. Setup and limits: docs/captcha-free.md.
// Nothing leaves the machine except the audio download from Google's own challenge frame.
import {execFile} from 'node:child_process';
import {mkdtemp,rm,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {agentPath} from './agent-capabilities.mjs';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
export const DEFAULT_MODEL=join(ROOT,'private/models/ggml-base.en.bin');
const BFRAME=/\/recaptcha\/(?:api2|enterprise)\/bframe/;
const ANCHOR=/\/recaptcha\/(?:api2|enterprise)\/anchor/;
export const runAudioCommand=(cmd,args,timeout=60000)=>new Promise((resolve,reject)=>
 execFile(cmd,args,{timeout,maxBuffer:4e6,env:{...process.env,PATH:agentPath(process.env.PATH??'')}},(e,stdout)=>e?reject(e):resolve(String(stdout))));

// reCAPTCHA audio answers are the spoken words; drop punctuation and casing only.
export function normalizeTranscript(text){
 return String(text).toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g,' ').replace(/[^a-z0-9' ]+/g,' ').replace(/\s+/g,' ').trim();
}

export async function transcribe(audio,{model=DEFAULT_MODEL,exec=runAudioCommand}={}){
 await access(model);
 const dir=await mkdtemp(join(tmpdir(),'captcha-audio-'));
 try{
  const mp3=join(dir,'challenge.mp3'),wav=join(dir,'challenge.wav');
  await writeFile(mp3,audio);
  await exec('ffmpeg',['-loglevel','error','-y','-i',mp3,'-ar','16000','-ac','1',wav]);
  return normalizeTranscript(await exec('whisper-cli',['-m',model,'-f',wav,'-nt','-np']));
 }finally{await rm(dir,{recursive:true,force:true});}
}

export const recaptchaFrames=page=>({
 bframe:page.frames().find(f=>BFRAME.test(f.url())),
 anchor:page.frames().find(f=>ANCHOR.test(f.url())),
});

// Google's "automated queries" refusal: audio is unavailable for this session.
const refused=frame=>frame.locator('.rc-doscaptcha-header, .rc-doscaptcha-body').first().isVisible().catch(()=>false);

export async function solveRecaptchaAudio(page,{attempts=3,transcribeImpl=transcribe,log=()=>{},wait=ms=>page.waitForTimeout(ms)}={}){
 let {bframe,anchor}=recaptchaFrames(page);
 if(!bframe)return {completed:false,reason:'no reCAPTCHA challenge frame'};
 // A checkbox widget opens its challenge only after the box is clicked.
 if(anchor&&!(await bframe.locator('#recaptcha-audio-button').isVisible().catch(()=>false)))
  await anchor.locator('#recaptcha-anchor').click({timeout:5000}).catch(()=>{});
 for(let attempt=1;attempt<=attempts;attempt++){
  ({bframe}=recaptchaFrames(page));if(!bframe)return {completed:true};
  const audioButton=bframe.locator('#recaptcha-audio-button');
  // The challenge frame renders a moment after it opens; wait for its audio button.
  if(await audioButton.waitFor({state:'visible',timeout:8000}).then(()=>true,()=>false)){
   await audioButton.click({timeout:5000});await wait(1500);
  }
  if(await refused(bframe))return {completed:false,reason:'reCAPTCHA refused the audio challenge for this browser'};
  const link=bframe.locator('.rc-audiochallenge-tdownload-link, #audio-source').first();
  const src=await link.getAttribute('href',{timeout:8000}).catch(()=>null)??await link.getAttribute('src').catch(()=>null);
  if(!src)return {completed:false,reason:'reCAPTCHA offered no audio challenge'};
  const response=await page.context().request.get(new URL(src,bframe.url()).href,{timeout:20000});
  if(!response.ok())return {completed:false,reason:'reCAPTCHA audio download failed'};
  const answer=await transcribeImpl(await response.body());
  await log(`Audio challenge attempt ${attempt}: transcribed ${answer.split(' ').filter(Boolean).length} words locally`);
  if(answer){
   await bframe.locator('#audio-response').fill(answer);
   await bframe.locator('#recaptcha-verify-button').click({timeout:5000});
   await wait(2500);
  }
  if(!(await challengeOpen(page)))return {completed:true};
  if(await refused(bframe))return {completed:false,reason:'reCAPTCHA refused the audio challenge for this browser'};
  await bframe.locator('#recaptcha-reload-button').click({timeout:5000}).catch(()=>{});await wait(1500);
 }
 return {completed:false,reason:`audio challenge not accepted after ${attempts} attempts`};
}

export async function challengeOpen(page){
 const {bframe}=recaptchaFrames(page);if(!bframe)return false;
 const el=await bframe.frameElement().catch(()=>null);if(!el)return false;
 return el.evaluate(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);
  let v=true;for(let n=e;n;n=n.parentElement){const t=getComputedStyle(n);if(t.visibility==='hidden'||t.display==='none'||Number(t.opacity)===0)v=false;}
  return v&&r.width>150&&r.height>100&&s.visibility!=='hidden';}).catch(()=>false);
}
