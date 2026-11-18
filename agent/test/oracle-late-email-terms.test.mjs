import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {atomic,runWorker} from '../src/dashboard-worker.mjs';

// Oracle CX (Howmet 11608): the apply/email page paints the required "I agree with the terms and conditions"
// checkbox and Next about 75 ms before its email input. A snapshot taken in that gap has no email control, and
// the account-page terms guard refused the checkbox. The guard now also reads the live page for an email input.
for(const emailRenders of [true,false]) test(`required terms checkbox with an email input that renders after the snapshot (email ${emailRenders?'appears':'never appears'})`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'late-email-terms-')),run=join(dir,'run');await mkdir(run);
 let release,rendered;const pending=new Promise(r=>release=r),ready=new Promise(r=>rendered=r);
 const server=createServer(async(req,res)=>{
  if(req.url==='/email'){await pending;res.end(emailRenders?'<label>Email Address<input type="email" name="primary-email" required></label>':'');return;}
  if(req.url==='/rendered'){rendered();res.end('ok');return;}
  if(req.url==='/favicon.ico'){res.end();return;}
  res.setHeader('Content-Type','text/html');
  res.end(`<h1>You don't need to have an account</h1><form onsubmit="return false"><div id="slot"></div><label><input id="legal-disclaimer-checkbox" type="checkbox" required> I agree with the terms and conditions</label><button type="submit">Next</button></form><script>fetch('/email').then(r=>r.text()).then(html=>{document.querySelector('#slot').innerHTML=html;fetch('/rendered')})</script>`);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=join(dir,'profile.json'),resume=join(dir,'resume.pdf');await writeFile(profile,JSON.stringify({answers:{}}));await writeFile(resume,'fixture');
 await atomic(join(run,'request.json'),{job:{id:11608,company:'Fixture',url:`http://127.0.0.1:${server.address().port}`},profilePath:profile,resumePath:resume,engine:'claude',parkQuestions:true});
 const decisions=[];
 const execImpl=async(_command,_args,prompt)=>{const controls=JSON.parse(prompt).page.frames.flatMap(f=>f.controls);decisions.push(controls.map(c=>c.type));
  const terms=controls.find(c=>c.type==='checkbox'&&/terms and conditions/.test(c.label));
  // The first decision sees the checkbox alone; the email input is released onto the page only while deciding.
  if(decisions.length===1&&terms){release();await ready;return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:'fill',control:terms.id,fact:'acceptTerms',message:''},usage:{}})};}
  return {code:0,stderr:'',stdout:JSON.stringify({structured_output:{action:'human',control:'',fact:'',message:'Fixture finished'},usage:{}})};
 };
 try{await runWorker(run,{execImpl,allowLocalFixture:true,stateRoot:join(dir,'state')}).catch(()=>{});const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));
  assert.ok(decisions.length>=1&&!decisions[0].includes('email'),'the first snapshot had no email control');
  const accepted=state.events.some(e=>/Accepted required terms: I agree with the terms and conditions/.test(e.message));
  if(emailRenders){assert.doesNotMatch(state.message??'',/Only a required terms checkbox/);assert.ok(accepted,'the checkbox was accepted');assert.ok(decisions[1]?.includes('email'),'the next snapshot saw the email input');}
  // Off an account page the in-form checkbox is an application question for him (RV Tech 13331): never ticked, flagged for approval.
  else{assert.match(state.message??'',/flagged for your approval/);assert.equal(accepted,false);}
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
