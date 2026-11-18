import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {completeSigninVerification,amazonSigninPage} from '../src/signin-verification.mjs';
import {oracleIdentityPage,verifiedOracleCode} from '../src/oracle-signin-verification.mjs';
const url='https://efds.fa.em5.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/123/apply/email';
const job={url,company:'Ford Motor Company'},now=Date.now(),after=new Date(now-30000).toISOString();
const options={email:'fixture@example.com',after,now:()=>now,wait:async()=>{}};
const message={messageId:'abcdef1234567890',receivedAt:new Date(now-10000).toISOString(),sender:'RecruitingNoReply@ford.com',recipients:['fixture@example.com'],subject:'Confirm your identity',body:`<img src="https://efds.fa.em5.oraclecloud.com:443/hcmUI/CandidateExperience/images?imageId=fixture">We need you to confirm your identity for your job application for using this code: <b>123456</b>.&nbsp;This code expires in 10 minutes.`};
const execFor=value=>async()=>({code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}})});
test('Oracle email identity requires bound tenant, sender, recipient, fresh message and full code body',()=>{
 assert.equal(amazonSigninPage(url,url),false); // Reproduces the previously unsupported gate.
 assert.equal(oracleIdentityPage(url,url),true);
 for(const bad of[url.replace('https:','http:'),url.replace('efds.','other.'),url.replace('oraclecloud.com','oraclecloud.com.evil.example')])assert.equal(oracleIdentityPage(bad,url),false);
 assert.equal(verifiedOracleCode(message,{...options,now,jobURL:url}),'123456');
 for(const change of[{sender:'attacker@example.com'},{recipients:['other@example.com']},{subject:'Other code'},{receivedAt:new Date(now-600001).toISOString()},{receivedAt:new Date(now-40000).toISOString()},{receivedAt:new Date(now+1000).toISOString()},{body:message.body.replace('efds.','other.')},{body:message.body.replace('123456','[one-time authentication code withheld]')}])assert.equal(verifiedOracleCode({...message,...change},{...options,now,jobURL:url}),null);
});
test('Vertiv Oracle tenant uses its own sender and one-time pass code template',()=>{
 const vurl='https://egup.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/123/apply/email';
 const vmessage={...message,sender:'egup.fa.sender.1@workflow.email.us-phoenix-1.ocs.oraclecloud.com',body:`<img src="https://egup.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/images?imageId=fixture">Just one more step before you get started.</td><td>You must confirm your identity using the one-time pass code : <b>654321</b></td><td>Note : This code will expire in 10 minutes.</td><td>Vertiv Talent Acquisition Team</td>`};
 assert.equal(verifiedOracleCode(vmessage,{...options,now,jobURL:vurl}),'654321');
 for(const change of[{sender:'RecruitingNoReply@ford.com'},{body:vmessage.body.replace('egup.','other.')},{body:vmessage.body.replace('Vertiv Talent','Other Talent')},{body:vmessage.body.replace('654321','[code withheld]')}])assert.equal(verifiedOracleCode({...vmessage,...change},{...options,now,jobURL:vurl}),null);
 assert.equal(verifiedOracleCode(vmessage,{...options,now,jobURL:url}),null); // Vertiv mail never verifies Ford.
});
test('Ralliant Oracle tenant mail has no links and binds by its own tenant sender',()=>{
 const rurl='https://ibwujb.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/10698/apply/email';
 const rmessage={...message,sender:'ibwujb.fa.sender@workflow.email.us-ashburn-1.ocs.oraclecloud.com',body:'Hello Fixture,<br><br>Just one more step before you get started.<br><br>You must confirm your identity using the one-time pass code : 246810<br><br>Note : This code will expire in 10 minutes.<br><br>Sincerely,<br><br>Ralliant Recruiting Team.'};
 assert.equal(verifiedOracleCode(rmessage,{...options,now,jobURL:rurl}),'246810');
 for(const change of[{sender:'egup.fa.sender.1@workflow.email.us-phoenix-1.ocs.oraclecloud.com'},{body:rmessage.body+' https://evil.example/x'},{body:rmessage.body.replace('Ralliant Recruiting','Other Recruiting')},{body:rmessage.body.replace('246810','[code withheld]')}])assert.equal(verifiedOracleCode({...rmessage,...change},{...options,now,jobURL:rurl}),null);
 assert.equal(verifiedOracleCode(rmessage,{...options,now,jobURL:url}),null); // Ralliant mail never verifies Ford.
});
test('headless Oracle six-box fixture bypasses stale controls, verifies once and never submits/resends',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();let posts=0,verifyClicks=0,resends=0,boxes=6,lookups=0,pin=false;
  await page.exposeFunction('verified',()=>verifyClicks++);await page.exposeFunction('resent',()=>resends++);
  await page.route('**/*',route=>{if(route.request().method()==='POST')posts++;return route.fulfill({contentType:'text/html',body:`<h1>Confirm Your Identity</h1><p>The verification code was sent to this email address: fixture@example.com</p>${(pin?'<input class="pin-code-input__input" type="text" inputmode="numeric">':'<input maxlength="1">').repeat(boxes)}<button onclick="if([...document.querySelectorAll('input')].map(x=>x.value).join('')==='123456'){verified();document.body.innerHTML='<h1>Candidate Application</h1>'}">VERIFY</button><button onclick="resent()">Send New Code</button>`});});
  await page.goto(url);
  const result=await completeSigninVerification(page,job,{...options,execImpl:async(...args)=>{lookups++;assert.match(args[2],/full-message read tool/);return execFor(lookups===1?{}:message)();}});
  assert.deepEqual(result,{needed:true,completed:true});assert.equal(lookups,2);assert.equal(verifyClicks,1);assert.equal(posts,0);assert.equal(resends,0);
  assert.deepEqual(await completeSigninVerification(page,job,{...options,execImpl:()=>assert.fail('no repeat lookup')}),{needed:false});
  for(const count of [5,7]){boxes=count;await page.goto(url);assert.deepEqual(await completeSigninVerification(page,job,{...options,execImpl:()=>assert.fail('ambiguous boxes')}),{needed:true,completed:false});}
  boxes=6;await page.goto(url);
  assert.deepEqual(await completeSigninVerification(page,job,{...options,execImpl:execFor({...message,body:message.body.replace('123456','[code withheld]')})}),{needed:true,completed:false});
  assert.deepEqual(await page.locator('input').evaluateAll(xs=>xs.map(x=>x.value)),Array(6).fill(''));
  await page.goto('https://other.fa.em5.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/123/apply/email');
  assert.deepEqual(await completeSigninVerification(page,job,{...options,execImpl:()=>assert.fail('foreign tenant')}),{needed:false});
  assert.equal(verifyClicks,1);assert.equal(posts,0);assert.equal(resends,0);
  // Vertiv's pin-code boxes have no maxlength (7922).
  pin=true;lookups=0;await page.goto(url);
  assert.deepEqual(await completeSigninVerification(page,job,{...options,execImpl:execFor(message)}),{needed:true,completed:true});assert.equal(verifyClicks,2);
 }finally{await browser.close();}
});

test('Howmet Oracle tenant uses its own sender, subject and image host (11608)',()=>{
 const hurl='https://fa-exty-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/119953/apply/email';
 const hmessage={...message,sender:'howmetTAdonotreply@howmet.com',subject:'Howmet Aerospace - Career Site Verification Code',body:'<img src="https://howmet.widen.net/content/fixture/jpeg/logo.jpeg?w=640"><div> Hello , </div><div> You must confirm your identity on the Career Site before moving forward. Your one-time verification code is: 246810. </div><div> This code will expire in 10 minutes. Please do not share this verification code with anyone else. </div><div> Howmet Aerospace Talent Acquisition Team </div>'};
 assert.equal(verifiedOracleCode(hmessage,{...options,now,jobURL:hurl}),'246810');
 for(const change of[{subject:'Confirm your identity'},{sender:'other@howmet.com'},{body:hmessage.body.replace('howmet.widen.net','evil.example')},{body:hmessage.body.replace('Howmet Aerospace Talent','Other Talent')}])assert.equal(verifiedOracleCode({...hmessage,...change},{...options,now,jobURL:hurl}),null);
 assert.equal(verifiedOracleCode(hmessage,{...options,now,jobURL:url}),null); // Howmet mail never verifies Ford.
 // A plain-text read drops the image tag; the template still binds it, but a foreign link does not.
 const plain={...hmessage,body:hmessage.body.replace(/<img[^>]*>/,'')};
 assert.equal(verifiedOracleCode(plain,{...options,now,jobURL:hurl}),'246810');
 assert.equal(verifiedOracleCode({...plain,body:plain.body+'<a href="https://evil.example/x">x</a>'},{...options,now,jobURL:hurl}),null);
 assert.equal(verifiedOracleCode({...message,body:message.body.replace(/<img[^>]*>/,'')},{...options,now,jobURL:url}),null); // Ford still needs its tenant link.
});
test('Ford vanity domain apply.ford.com is the efds Oracle tenant for the identity gate (Ford 12635)',()=>{
 const furl='https://apply.ford.com/en/sites/CX_1/job/72878/apply/email',fjob='https://apply.ford.com/en/sites/CX_1/job/72878/?utm_medium=career+site';
 assert.equal(oracleIdentityPage(furl,fjob),true);
 for(const bad of[furl.replace('https:','http:'),furl.replace('apply.ford.com','apply.ford.com.evil.example'),'https://apply.ford.com/other/page'])assert.equal(oracleIdentityPage(bad,fjob),false);
 assert.equal(verifiedOracleCode(message,{...options,now,jobURL:fjob}),'123456'); // Mail still links the efds tenant.
 assert.equal(verifiedOracleCode({...message,body:message.body.replace('efds.','other.')},{...options,now,jobURL:fjob}),null);
});
test('headless apply.ford.com identity gate is filled from Ford mail instead of asking the model (Ford 12635)',async()=>{
 const furl='https://apply.ford.com/en/sites/CX_1/job/72878/apply/email',fjob={url:'https://apply.ford.com/en/sites/CX_1/job/72878/?utm_medium=career+site',company:'Ford'};
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();let verifyClicks=0,posts=0;await page.exposeFunction('verified',()=>verifyClicks++);
  await page.route('**/*',route=>{if(route.request().method()==='POST')posts++;return route.fulfill({contentType:'text/html',body:`<h1>Confirm Your Identity</h1><p>The verification code was sent to this email address: fixture@example.com</p>${'<input maxlength="1">'.repeat(6)}<button onclick="if([...document.querySelectorAll('input')].map(x=>x.value).join('')==='123456'){verified();document.body.innerHTML='<h1>Candidate Application</h1>'}">VERIFY</button><button>Send New Code</button>`});});
  await page.goto(furl);
  assert.deepEqual(await completeSigninVerification(page,fjob,{...options,execImpl:execFor(message)}),{needed:true,completed:true});
  assert.equal(verifyClicks,1);assert.equal(posts,0);
 }finally{await browser.close();}
});

test('onsemi Oracle tenant binds by its own sender, subject and ircEmailPreview link (11314)',()=>{
 const ourl='https://hctz.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/2506814/apply/email';
 const omessage={...message,sender:'hctz.fa.sender@workflow.email.us-phoenix-1.ocs.oraclecloud.com',subject:'onsemi Confirm Your Identity',body:'<a href="https://hctz.fa.us2.oraclecloud.com:443/hcmUI/CandidateExperience/ircEmailPreview?referenceId=fixture">View in Browser</a><img src="https://ok12static.oktacdn.com/fs/bco/1/fixture">Hello Fixture,<br><br>You must confirm your identity using the one-time pass code : 135790<br><br>Note : This code will expire in 10 minutes.<br><br>Sincerely,<br><br><font><span><b>onsemi</b>&nbsp;</span></font>Talent Acquisition Team'};
 assert.equal(verifiedOracleCode(omessage,{...options,now,jobURL:ourl}),'135790');
 for(const change of[{subject:'Confirm your identity'},{sender:'ibwujb.fa.sender@workflow.email.us-ashburn-1.ocs.oraclecloud.com'},{body:omessage.body.replace('hctz.','other.')},{body:omessage.body.replace('<b>onsemi</b>','<b>Other</b>')},{body:omessage.body.replace('135790','[code withheld]')}])assert.equal(verifiedOracleCode({...omessage,...change},{...options,now,jobURL:ourl}),null);
 assert.equal(verifiedOracleCode(omessage,{...options,now,jobURL:url}),null); // onsemi mail never verifies Ford.
});
