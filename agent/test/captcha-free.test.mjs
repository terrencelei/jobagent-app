import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeTranscript,solveRecaptchaAudio} from '../src/captcha-audio.mjs';
import {waitForHuman,resolveChallengeFree} from '../src/captcha-handoff.mjs';
// the local tier runs on these fakes too: keep it quiet and offline
process.env.CAPTCHA_LOG='0';process.env.CAPTCHA_SHOTS='0';process.env.CAPTCHA_LOCAL_MODELS='0';process.env.CAPTCHA_VISION='0';

test('transcripts keep only the spoken words',()=>{
 assert.equal(normalizeTranscript(' 7 Green Apples, on the Table. [BLANK_AUDIO]'),'7 green apples on the table');
 assert.equal(normalizeTranscript('(music)'),'');
});

test('no challenge frame means the audio solver does nothing',async()=>{
 const page={frames:()=>[{url:()=>'https://jobs.example.com/apply'}]};
 assert.deepEqual(await solveRecaptchaAudio(page),{completed:false,reason:'no reCAPTCHA challenge frame'});
});

test('handoff notifies once and completes when the challenge disappears',async()=>{
 let t=0,checks=0;const notes=[];
 const page={bringToFront:async()=>{},isClosed:()=>false};
 const result=await waitForHuman(page,{challengeVisible:async()=>++checks<3,notify:async(...a)=>notes.push(a),now:()=>t,wait:async ms=>{t+=ms;},company:'Example'});
 assert.deepEqual(result,{completed:true,by:'human'});
 assert.equal(notes.length,1);assert.match(notes[0][1],/Example/);
});

test('handoff gives up at the deadline without claiming success',async()=>{
 let t=0;const page={bringToFront:async()=>{},isClosed:()=>false};
 const result=await waitForHuman(page,{challengeVisible:async()=>true,notify:async()=>{},now:()=>t,wait:async ms=>{t+=ms;},timeoutMs:60000});
 assert.equal(result.completed,false);assert.match(result.reason,/not solved within 1 min/);
});

const recaptchaPage={frames:()=>[{url:()=>'https://www.recaptcha.net/recaptcha/enterprise/bframe?k=x'}]};
test('reCAPTCHA tries free audio first and skips the handoff when it works',async()=>{
 let humanCalled=false;
 const r=await resolveChallengeFree(recaptchaPage,{challengeVisible:async()=>false,headless:false,audio:async()=>({completed:true}),human:async()=>{humanCalled=true;}});
 assert.deepEqual(r,{completed:true,by:'audio'});assert.equal(humanCalled,false);
});

test('refused audio falls back to the human; a headless run reports that no handoff window exists',async()=>{
 const audio=async()=>({completed:false,reason:'reCAPTCHA refused the audio challenge for this browser'});
 const human=async()=>({completed:true,by:'human'});
 assert.deepEqual(await resolveChallengeFree(recaptchaPage,{challengeVisible:async()=>true,headless:false,audio,human}),{completed:true,by:'human'});
 const headless=await resolveChallengeFree(recaptchaPage,{challengeVisible:async()=>true,headless:true,audio,human});
 assert.equal(headless.completed,false);assert.match(headless.reason,/refused.*headless/);
});

test('hCaptcha goes straight to the human handoff',async()=>{
 const page={frames:()=>[{url:()=>'https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=challenge'}]};
 let audioCalled=false;
 const r=await resolveChallengeFree(page,{challengeVisible:async()=>true,headless:false,audio:async()=>{audioCalled=true;},human:async()=>({completed:true,by:'human'})});
 assert.equal(r.by,'human');assert.equal(audioCalled,false);
});

import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {captchaSeen,recordCaptcha} from '../src/captcha-handoff.mjs';
test('a posting that showed a CAPTCHA is remembered by its canonical URL',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'captcha-seen-'));
 try{
  assert.equal(await captchaSeen(dir,'https://jobs.example.com/a/apply'),false);
  await recordCaptcha(dir,'https://jobs.example.com/a/apply?utm=x','post-submit');
  assert.equal(await captchaSeen(dir,'https://jobs.example.com/a/apply'),true);
  assert.equal(await captchaSeen(dir,'https://jobs.example.com/b/apply'),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('an audio solver exception still reaches the hand-off, and a hand-off exception is reported',async()=>{
 const audio=async()=>{throw new Error('whisper-cli not found');};
 const ok=await resolveChallengeFree(recaptchaPage,{challengeVisible:async()=>true,headless:false,audio,human:async()=>({completed:true,by:'human'})});
 assert.equal(ok.by,'human');
 const bad=await resolveChallengeFree(recaptchaPage,{challengeVisible:async()=>true,headless:false,audio,human:async()=>{throw new Error('page closed');}});
 assert.equal(bad.completed,false);assert.match(bad.reason,/audio solver error: whisper-cli not found; hand-off error: page closed/);
});

import {captchaManualFirst} from '../src/captcha-handoff.mjs';import {writeFile} from 'node:fs/promises';
test('a manual-first posting skips audio in a visible window and keeps the mark when re-recorded',async()=>{
 let audioCalled=false;
 const r=await resolveChallengeFree(recaptchaPage,{challengeVisible:async()=>true,headless:false,manualFirst:true,audio:async()=>{audioCalled=true;return {completed:true};},human:async()=>({completed:true,by:'human'})});
 assert.equal(r.by,'human');assert.equal(audioCalled,false);
 const dir=await mkdtemp(join(tmpdir(),'captcha-manual-'));
 try{
  await writeFile(join(dir,'captcha-postings.json'),JSON.stringify({'https://jobs.example.com/a/apply':{kind:'post-submit',manualFirst:true}}));
  assert.equal(await captchaManualFirst(dir,'https://jobs.example.com/a/apply?x=1'),true);
  await recordCaptcha(dir,'https://jobs.example.com/a/apply','post-submit');
  assert.equal(await captchaManualFirst(dir,'https://jobs.example.com/a/apply'),true);
  assert.equal(await captchaManualFirst(dir,'https://jobs.example.com/b/apply'),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('manual handoff survives a temporary gap between CAPTCHA puzzle frames',async()=>{
 let time=0,index=0;const states=[true,false,true,false,false,false];
 const result=await waitForHuman({bringToFront:async()=>{},isClosed:()=>false},{
  challengeVisible:async()=>states[index++]??false,notify:async()=>{},now:()=>time,
  pollMs:1000,settleMs:2000,wait:async ms=>{time+=ms;}});
 assert.deepEqual(result,{completed:true,by:'human'});assert.equal(index,6);assert.equal(time,5000);
});

import {captchaLikely} from '../src/captcha-handoff.mjs';
// Only manual runs (headlessOnly not set) open a visible window for these boards; unattended runs stay headless (2026-10-17).
test('Ashby, Lever and JazzHR boards are recognised as likely to show a CAPTCHA',()=>{
 for(const u of ['https://jobs.ashbyhq.com/x/1/application','https://jobs.lever.co/x/1/apply','https://aerotech.theresumator.com/apply/a/b'])assert.equal(captchaLikely(u),true,u);
 for(const u of ['https://boards.greenhouse.io/x/jobs/1','https://x.wd5.myworkdayjobs.com/en-US/y','not a url'])assert.equal(captchaLikely(u),false,u);
});
