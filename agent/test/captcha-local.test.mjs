import test from 'node:test';import assert from 'node:assert/strict';
import {classify,isWall,vendorText,identify,recordHcapVerdict} from '../src/captcha-identify.mjs';
import {lastJson,declined,resultLine,visionArgs,visionJson} from '../src/captcha-vision.mjs';
import {callService,localModelsDisabled} from '../src/captcha-service.mjs';
import {solveCaptchaLocally,stillThere,encounterRecord,ORDER,SOLVERS} from '../src/captcha-local.mjs';
import {resolveChallengeFree} from '../src/captcha-handoff.mjs';
import {dismissConsent,BUTTONS} from '../src/consent-dismiss.mjs';

process.env.CAPTCHA_LOG='0';process.env.CAPTCHA_SHOTS='0';process.env.CAPTCHA_LOCAL_MODELS='0';process.env.CAPTCHA_VISION='0';

// -- classification (pure) --------------------------------------------------------------------------
const none={};
test('an open reCAPTCHA challenge frame is a challenge; a parked one is not',()=>{
 const open=classify({frames:[{url:'https://www.google.com/recaptcha/api2/bframe?k=x',shown:true,rendered:true}],signals:[]});
 assert.deepEqual(open.map(v=>v.vendor+'/'+v.kind),['recaptcha/challenge']);
 const parked=classify({frames:[{url:'https://www.google.com/recaptcha/api2/bframe?k=x',shown:true,rendered:false}],signals:[]});
 assert.deepEqual(parked,[]);
});
test('invisible reCAPTCHA (score-based) is reported as not solvable, a checkbox anchor as solvable',()=>{
 const v=classify({frames:[{url:'https://www.google.com/recaptcha/enterprise/anchor?k=x&size=invisible'},{url:'https://www.recaptcha.net/recaptcha/api2/anchor?k=y'}],signals:[]});
 assert.deepEqual(v,[{vendor:'recaptcha',kind:'invisible',solvable:false,note:'score-based (v3 / invisible / Enterprise): there is nothing to click'},{vendor:'recaptcha',kind:'checkbox',solvable:true}]);
});
test('hCaptcha frames: enclave ignored, checkbox-invisible is invisible, open challenge is a challenge',()=>{
 const v=classify({frames:[
  {url:'https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=enclave'},
  {url:'https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=checkbox-invisible'},
  {url:'https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=challenge',shown:true,rendered:true},
 ],signals:[]});
 assert.deepEqual(v.map(x=>x.kind),['invisible','challenge']);
});
test('edge walls are never solvable; a 403 counts only in the main frame; arithmetic CAPTCHAs are policy, not OCR',()=>{
 const walls=classify({frames:[],signals:[{s:{...none,akamai:true},main:true},{s:{...none,forbidden:true},main:false}]});
 assert.deepEqual(walls.map(v=>v.vendor+'/'+v.kind),['akamai/wall']);
 assert.equal(isWall(walls),true);
 const math=classify({frames:[],signals:[{s:{...none,math:true,textImage:true},main:true}]});
 assert.deepEqual(math.map(v=>v.vendor+'/'+v.kind+'/'+v.solvable),['math/arithmetic/false']);
 const ocr=classify({frames:[],signals:[{s:{...none,textImage:true},main:true}]});
 assert.deepEqual(ocr.map(v=>v.vendor+'/'+v.kind),['text-image/ocr']);
 assert.equal(vendorText([]),'unidentified');
});
test('a vendor frame that no longer shows a puzzle is skipped; Turnstile host without a frame is still a widget',()=>{
 const gone=classify({frames:[{url:'https://geo.captcha-delivery.com/captcha/?x',showsPuzzle:false}],signals:[]});
 assert.deepEqual(gone,[]);
 const host=classify({frames:[],signals:[{s:{...none,turnstileHost:true},main:true}]});
 assert.deepEqual(host.map(v=>v.vendor+'/'+v.kind),['turnstile/widget']);
});

// -- identify on fakes --------------------------------------------------------------------------------
const fakeFrame=(url,{main=false,evaluate=async()=>null,box=null}={})=>({url:()=>url,evaluate,frameElement:async()=>({boundingBox:async()=>box,evaluate:async()=>true,dispose:async()=>{},scrollIntoViewIfNeeded:async()=>{}}),page:()=>({viewportSize:()=>({width:1280,height:1000})}),_main:main});
const fakePage=frames=>({frames:()=>frames,mainFrame:()=>frames.find(f=>f._main)||frames[0],url:()=>'https://jobs.example.com/apply',on(){},off(){}});
test('identify tolerates a page whose frames cannot be evaluated and reports nothing',async()=>{
 const page={frames:()=>[{url:()=>'https://jobs.example.com/apply'}],mainFrame(){return this.frames()[0];},url:()=>'x'};
 assert.deepEqual(await identify(page),[]);
});
test('identify reports an hCaptcha widget with no on-screen checkbox and no open challenge as invisible',async()=>{
 const main=fakeFrame('https://jobs.lever.co/x/apply',{main:true,evaluate:async fn=>typeof fn==='function'&&/domSignals|akamai/.test(fn.toString())?{}:false});
 const hc=fakeFrame('https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=checkbox',{box:{x:0,y:-9915,width:303,height:78}});
 const v=await identify(fakePage([main,hc]));
 assert.deepEqual(v.map(x=>x.vendor+'/'+x.kind+'/'+x.solvable),['hcaptcha/invisible/true']);
});
test('identify reports an hCaptcha whose server verdict was a pass as solved',async()=>{
 const main=fakeFrame('https://jobs.lever.co/x/apply',{main:true,evaluate:async()=>({})});
 const hc=fakeFrame('https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=checkbox',{box:{x:10,y:10,width:303,height:78}});
 const page=fakePage([main,hc]);
 recordHcapVerdict(page,true);
 assert.deepEqual(await identify(page),[{vendor:'hcaptcha',kind:'solved',solvable:false}]);
});

// -- vision helpers ------------------------------------------------------------------------------------
test('lastJson finds the final JSON in prose and fenced replies',()=>{
 assert.deepEqual(lastJson('Sure. ```json\n{"tiles":[1,2]}\n```'),{tiles:[1,2]});
 assert.deepEqual(lastJson('I see [2, 5, 9]'),[2,5,9]);
 assert.deepEqual(lastJson('first {"a":1} then {"b":2}'),{b:2});
 assert.equal(lastJson('nothing here'),null);
});
test('a refusal with no JSON is a decline; a JSON answer never is',()=>{
 assert.equal(declined("I can't help with solving CAPTCHAs designed to verify that a human is present.",null),true);
 assert.equal(declined('[1,2]',[1,2]),false);
 assert.equal(declined('Here you go',null),false);
});
test('the vision CLI runs one turn with no tools or MCP servers and parses the stream-json result line',()=>{
 const a=visionArgs('sonnet');
 assert.ok(a.includes('--max-turns')&&a[a.indexOf('--max-turns')+1]==='1');
 assert.ok(a.includes('--strict-mcp-config')&&a[a.indexOf('--tools')+1]==='');
 assert.ok(a.includes('--no-session-persistence'));
 assert.deepEqual(resultLine('{"type":"system"}\n{"type":"result","subtype":"success","result":"[3]"}\n'),{type:'result',subtype:'success',result:'[3]'});
 assert.equal(resultLine('garbage'),null);
});
test('CAPTCHA_VISION=0 turns the vision tier off without spawning anything',async()=>{
 const r=await visionJson(Buffer.from('png'),'q',{spawnImpl:()=>{throw new Error('must not spawn');}});
 assert.equal(r.json,null);assert.match(r.error,/disabled/);
});
test('a usage-limited model falls back to the next one down with the same prompt',async()=>{
 const seen=[];
 const spawnImpl=(bin,args)=>{
  const model=args[args.indexOf('--model')+1];seen.push(model);
  const handlers={};const line=model==='sonnet'?'{"type":"result","subtype":"error","is_error":true,"result":"usage limit reached"}':'{"type":"result","subtype":"success","result":"{\\"tiles\\":[4]}"}';
  return {stdout:{on:(e,f)=>{if(e==='data')setTimeout(()=>f(line+'\n'),0);}},stderr:{on(){}},on:(e,f)=>{handlers[e]=f;if(e==='close')setTimeout(()=>f(0),5);},stdin:{end(){}},kill(){}};
 };
 const r=await visionJson(Buffer.from('png'),'q',{model:'sonnet',spawnImpl,env:{},bin:'claude'});
 assert.deepEqual(seen,['sonnet','haiku']);assert.deepEqual(r.json,{tiles:[4]});assert.equal(r.model,'haiku');
});

// -- service client ------------------------------------------------------------------------------------
test('with local models disabled the service client answers ok:false and never starts anything',async()=>{
 assert.equal(localModelsDisabled(),true);
 const r=await callService('/ocr',{image_b64:'x'},{fetchImpl:()=>{throw new Error('no network');}});
 assert.equal(r.ok,false);assert.match(r.error,/disabled/);
});
test('an unavailable service is reported, not thrown',async()=>{
 delete process.env.CAPTCHA_LOCAL_MODELS;
 const r=await callService('/ocr',{},{ensure:async()=>false,fetchImpl:async()=>{throw new Error('x');}});
 assert.equal(r.ok,false);assert.match(r.error,/unavailable/);
 const ok=await callService('/ocr',{},{ensure:async()=>true,fetchImpl:async()=>({json:async()=>({ok:true,text:'abc'})})});
 assert.deepEqual(ok,{ok:true,text:'abc'});
 process.env.CAPTCHA_LOCAL_MODELS='0';
});

// -- orchestration -------------------------------------------------------------------------------------
const quietPage=()=>({frames:()=>[],mainFrame:()=>({url:()=>'https://jobs.example.com/apply',evaluate:async()=>''}),url:()=>'https://jobs.example.com/apply',on(){},off(){},waitForTimeout:async()=>{},locator:()=>({first:()=>({isVisible:async()=>false})})});
test('a page with no CAPTCHA is type none and nothing is logged or solved',async()=>{
 const r=await solveCaptchaLocally(quietPage(),{identifyImpl:async()=>[]});
 assert.equal(r.type,'none');assert.equal(r.solved,false);
});
test('a wall is reported as a wall without any solver running',async()=>{
 let ran=false;
 const r=await solveCaptchaLocally(quietPage(),{identifyImpl:async()=>[{vendor:'akamai',kind:'wall',solvable:false}],solvers:{...SOLVERS,'recaptcha/checkbox':async()=>{ran=true;}}});
 assert.equal(r.wall,true);assert.equal(r.type,'antibot-wall');assert.equal(ran,false);
});
test('an arithmetic CAPTCHA is left unanswered with its policy note',async()=>{
 const r=await solveCaptchaLocally(quietPage(),{identifyImpl:async()=>[{vendor:'math',kind:'arithmetic',solvable:false,note:'never answered'}]});
 assert.equal(r.type,'math-policy');assert.equal(r.policy,'never answered');assert.equal(r.solved,false);
});
test('solvers run in ORDER, stop when the widget is gone, and the solve is reported with its trace',async()=>{
 const calls=[];let hcapLeft=2;
 const identifyImpl=async()=>hcapLeft>0?[{vendor:'turnstile',kind:'widget',solvable:true},{vendor:'hcaptcha',kind:'challenge',solvable:true}]:[{vendor:'hcaptcha',kind:'solved',solvable:false}];
 const solvers={...SOLVERS,'turnstile/widget':async()=>{calls.push('turnstile');},'hcaptcha/challenge':async()=>{calls.push('hcaptcha');hcapLeft--;}};
 const page={...quietPage(),frames:()=>[]};
 let n=0;
 const still=async(p,key)=>key==='turnstile/widget'?false:hcapLeft>0;
 const r=await solveCaptchaLocally(page,{identifyImpl,solvers,wait:async()=>{n++;}});
 // stillThere is module-internal; emulate through identify: turnstile has no frames/token so it reads as gone
 void still;
 assert.equal(calls[0],'turnstile');assert.ok(calls.filter(c=>c==='hcaptcha').length>=1);
 assert.equal(r.solved,true);assert.equal(r.type,'turnstile/widget+hcaptcha/challenge');
 assert.ok(ORDER.indexOf('turnstile/widget')<ORDER.indexOf('hcaptcha/challenge'));
});
test('a solver that keeps failing stops after maxAttempts and names the vendor',async()=>{
 const identifyImpl=async()=>[{vendor:'recaptcha',kind:'checkbox',solvable:true}];
 const page={...quietPage(),frames:()=>[{url:()=>'https://www.google.com/recaptcha/api2/anchor?k=x',frameElement:async()=>({boundingBox:async()=>({x:0,y:0,width:304,height:78}),dispose:async()=>{},scrollIntoViewIfNeeded:async()=>{},evaluate:async()=>true}),evaluate:async()=>false,page:()=>({viewportSize:()=>({width:1280,height:1000})})}]};
 page.mainFrame=()=>({url:()=>'x',evaluate:async()=>''});
 let tries=0;
 const r=await solveCaptchaLocally(page,{identifyImpl,maxAttempts:2,solvers:{...SOLVERS,'recaptcha/checkbox':async()=>{tries++;}}});
 assert.equal(tries,2);assert.equal(r.solved,false);assert.equal(r.type,'recaptcha/checkbox');assert.equal(r.attempts,2);
});
test('a solver exception is contained and reported as a trace, not thrown',async()=>{
 const identifyImpl=async()=>[{vendor:'text-image',kind:'ocr',solvable:true}];
 const r=await solveCaptchaLocally(quietPage(),{identifyImpl,maxAttempts:1,solvers:{...SOLVERS,'text-image/ocr':async()=>{throw new Error('boom');}}});
 assert.equal(r.solved,false);assert.match(r.how,/text-image\/ocr threw: boom/);
});
test('stillThere for an unknown key defers to identify',async()=>{
 assert.equal(await stillThere(quietPage(),'geetest/challenge',{identifyImpl:async()=>[{vendor:'geetest',kind:'challenge'}]}),true);
 assert.equal(await stillThere(quietPage(),'geetest/challenge',{identifyImpl:async()=>[]}),false);
});
test('the encounter record names the vendors met, never personal data',()=>{
 const rec=encounterRecord({type:'hcaptcha/challenge',solved:true,how:'hCaptcha image rounds (vision)',attempts:1,vendors:[{vendor:'hcaptcha',kind:'solved'}]},{page:{url:()=>'https://jobs.lever.co/x/apply'},company:'Example',url:'https://jobs.lever.co/x/apply',secs:12.3});
 assert.deepEqual(rec.vendors,['hcaptcha/challenge']);assert.equal(rec.host,'jobs.lever.co');assert.equal(rec.solved,true);assert.equal(rec.company,'Example');
 assert.deepEqual(Object.keys(rec).sort(),['attempts','company','declined','host','how','job','policy','role','secs','shots','solved','ts','type','vendors','wall','worker']);
});

// -- the free tiers --------------------------------------------------------------------------------------
const recaptchaPage={frames:()=>[{url:()=>'https://www.recaptcha.net/recaptcha/enterprise/bframe?k=x'}]};
test('the local solver is tier 0: when it solves, neither audio nor the handoff runs',async()=>{
 let audio=false,human=false;
 const r=await resolveChallengeFree(recaptchaPage,{challengeVisible:async()=>false,headless:true,local:async()=>({solved:true,type:'recaptcha/challenge',how:'image grid (yolo)'}),audio:async()=>{audio=true;},human:async()=>{human=true;}});
 assert.deepEqual(r,{completed:true,by:'local:recaptcha/challenge',how:'image grid (yolo)'});assert.equal(audio,false);assert.equal(human,false);
});
test('a reCAPTCHA the local solver already worked on is not given to the audio tier again; the handoff still follows headed',async()=>{
 let audio=false;
 const local=async()=>({solved:false,type:'recaptcha/challenge',vendorText:'recaptcha/challenge',how:'audio: refused, image grid (yolo)'});
 const headless=await resolveChallengeFree(recaptchaPage,{challengeVisible:async()=>true,headless:true,local,audio:async()=>{audio=true;return {completed:true};},human:async()=>({completed:true,by:'human'})});
 assert.equal(headless.completed,false);assert.equal(audio,false);assert.match(headless.reason,/local solver \(recaptcha\/challenge\): audio: refused, image grid \(yolo\); browser is headless/);
 const headed=await resolveChallengeFree(recaptchaPage,{challengeVisible:async()=>true,headless:false,local,audio:async()=>{audio=true;return {completed:false};},human:async()=>({completed:true,by:'human'})});
 assert.equal(headed.by,'human');assert.equal(audio,false);
});
test('a local solver that saw nothing leaves the audio tier to run as before',async()=>{
 const r=await resolveChallengeFree(recaptchaPage,{challengeVisible:async()=>false,headless:false,local:async()=>({solved:false,type:'none'}),audio:async()=>({completed:true}),human:async()=>({completed:true,by:'human'})});
 assert.deepEqual(r,{completed:true,by:'audio'});
});
test('a wall, a vision decline and an arithmetic policy end the free tiers without a handoff',async()=>{
 let human=false;const humanFn=async()=>{human=true;return {completed:true,by:'human'};};
 const wall=await resolveChallengeFree(recaptchaPage,{challengeVisible:async()=>true,headless:false,local:async()=>({solved:false,type:'antibot-wall',wall:true,vendorText:'akamai/wall'}),audio:async()=>({completed:false}),human:humanFn});
 assert.equal(wall.wall,true);assert.equal(wall.completed,false);
 const dec=await resolveChallengeFree(recaptchaPage,{challengeVisible:async()=>true,headless:false,local:async()=>({solved:false,type:'hcaptcha/challenge',declined:true,vendorText:'hcaptcha/challenge'}),human:humanFn});
 assert.equal(dec.declined,true);assert.match(dec.reason,/declined/);
 const pol=await resolveChallengeFree(recaptchaPage,{challengeVisible:async()=>true,headless:false,local:async()=>({solved:false,type:'math-policy',policy:'arithmetic never answered',vendorText:'math/arithmetic'}),human:humanFn});
 assert.equal(pol.policy,'arithmetic never answered');
 assert.equal(human,false);
});
test('manualFirst in a visible window skips the local solver too',async()=>{
 let local=false;
 const r=await resolveChallengeFree(recaptchaPage,{challengeVisible:async()=>true,headless:false,manualFirst:true,local:async()=>{local=true;},audio:async()=>{throw new Error('no');},human:async()=>({completed:true,by:'human'})});
 assert.equal(r.by,'human');assert.equal(local,false);
});
test('a local solver exception reaches the next tier with its message',async()=>{
 const r=await resolveChallengeFree(recaptchaPage,{challengeVisible:async()=>true,headless:true,local:async()=>{throw new Error('service down');},audio:async()=>({completed:false,reason:'refused'}),human:async()=>({completed:true,by:'human'})});
 assert.equal(r.completed,false);assert.match(r.reason,/local solver error: service down; refused; browser is headless/);
});

// -- consent -------------------------------------------------------------------------------------------------
test('consent dismissal prefers the least-consent button and skips CAPTCHA vendor frames',async()=>{
 assert.ok(BUTTONS.indexOf('#onetrust-reject-all-handler')<BUTTONS.indexOf('#onetrust-accept-btn-handler'));
 const asked=[];
 const frame=(url,answer)=>({url:()=>url,evaluate:async()=>{asked.push(url);return answer;}});
 const page={frames:()=>[frame('https://jobs.example.com/apply','clicked #onetrust-reject-all-handler'),frame('https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=challenge','never')],waitForTimeout:async()=>{}};
 let rounds=0;
 const done=await dismissConsent(page,{wait:async()=>{rounds++;}});
 assert.deepEqual(done.slice(0,1),['clicked #onetrust-reject-all-handler']);
 assert.ok(asked.every(u=>!/hcaptcha/.test(u)));
 assert.ok(rounds<=3);
});
