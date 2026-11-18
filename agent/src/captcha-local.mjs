// Free, local, headless CAPTCHA solving (2026-10-24; ported from a CommonJS solver the user supplied).
// Tier 0 of docs/captcha-free.md: runs before the audio-only tier, the hand-off and 2Captcha.
//
//   reCAPTCHA v2 / Enterprise  checkbox -> accessibility audio (whisper.cpp) -> image grid: local YOLO tile
//                              classifier + COCO segmentation (tools/captcha-service.py), vision only for the
//                              uncertain tiles. Works headless, where Google refuses audio.
//   hCaptcha                   checkbox / invisible (hcaptcha.execute) / open challenge: numbered tiles,
//                              grid-guided point tasks and drag puzzles answered by the vision tier.
//   Turnstile, Cloudflare interstitial, PerimeterX press-and-hold, proof-of-work widgets (Friendly Captcha,
//   ALTCHA, mCaptcha), text-image CAPTCHAs (OCR ensemble), sliders in any frame (DataDome, GeeTest, generic),
//   AWS WAF and Arkose rounds (vision, best effort).
//
// Never opens a window. Never tries to get past an edge block (Akamai / Kasada / Incapsula / DataDome
// block / 403): those are walls, reported as such. Arithmetic CAPTCHAs are detected but never answered
// (trap-question rule). A vision decline ends the solve. Every encounter is logged to
// state/captcha-log.jsonl and every miss leaves screenshots under state/captcha-debug/<day>/<id>/.
import {existsSync,mkdirSync,writeFileSync,appendFileSync,readdirSync,rmSync} from 'node:fs';
import {join,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {callService} from './captcha-service.mjs';
import {visionJson,annotate} from './captcha-vision.mjs';
import {dismissConsent} from './consent-dismiss.mjs';
import {solveRecaptchaAudio} from './captcha-audio.mjs';
import {siteThrottled} from './throttle.mjs';
import {identify,isWall,vendorText,scan,framesMatching,frameBox,frameStyleVisible,visibleFrame,pageRect,domRects,textOf,anyFrame,
 recapChecked,hcapToken,hcapChallenge,tsToken,mtcapVerified,watchHcapVerdict,hcapPassedSince,siteOpened,markOpened,safeEval} from './captcha-identify.mjs';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
const LOG_FILE=()=>process.env.CAPTCHA_LOG_FILE||join(ROOT,'state/captcha-log.jsonl');
const DEBUG_ROOT=()=>process.env.CAPTCHA_DEBUG_ROOT||join(ROOT,'state/captcha-debug');

// -- per-solve state ------------------------------------------------------------------------------
let TRACE=[];const trace=x=>{TRACE.push(String(x));};
let DECLINED=false;let SOLVE_T0=Date.now();let DBG=null;
const dbgDir=()=>process.env.CAPTCHA_SHOTS==='0'?null:DBG;
function newDbg(company){
 if(process.env.CAPTCHA_SHOTS==='0'){DBG=null;return;}
 const root=DEBUG_ROOT(),day=new Date().toISOString().slice(0,10);
 DBG=join(root,day,Date.now().toString(36)+'-'+String(company||'probe').replace(/[^a-z0-9]+/gi,'-').slice(0,30));
 try{for(const d of readdirSync(root))if(d<new Date(Date.now()-3*864e5).toISOString().slice(0,10))rmSync(join(root,d),{recursive:true,force:true});}catch{}
}
function keep(name,buf,meta){const d=dbgDir();if(!d)return;try{mkdirSync(d,{recursive:true});if(buf)writeFileSync(join(d,name),buf);if(meta)writeFileSync(join(d,name.replace(/\.png$/,'')+'.json'),JSON.stringify(meta,null,1));}catch{}}

// -- human-like input -----------------------------------------------------------------------------
const rnd=n=>Math.random()*n;
export async function humanClick(page,x,y){
 const jx=x+(Math.random()-0.5)*4,jy=y+(Math.random()-0.5)*4;
 await page.mouse.move(jx,jy,{steps:6+Math.floor(rnd(6))});
 await page.waitForTimeout(40+Math.floor(rnd(60)));
 await page.mouse.click(jx,jy);
}
export async function humanDrag(page,startX,startY,distanceX,{verticalDist=0}={}){
 const overshootX=Math.floor(rnd(4))+3,steps=28+Math.floor(rnd(12));
 await page.mouse.move(startX-20-rnd(30),startY+10+rnd(10),{steps:4});
 await page.mouse.move(startX,startY,{steps:6});
 await page.waitForTimeout(80+Math.floor(rnd(60)));
 await page.mouse.down();
 for(let i=1;i<=steps;i++){
  const t=i/steps,ease=1-Math.pow(1-t,3);
  await page.mouse.move(startX+(distanceX+overshootX)*ease,startY+verticalDist*ease+Math.sin(t*Math.PI*2)*2.5);
  await page.waitForTimeout(8+Math.floor(rnd(10)));
 }
 await page.waitForTimeout(90+Math.floor(rnd(60)));
 await page.mouse.move(startX+distanceX,startY+verticalDist+1,{steps:5});
 await page.waitForTimeout(120+Math.floor(rnd(80)));
 await page.mouse.up();
}
export async function humanDragTo(page,fromX,fromY,toX,toY){
 const steps=30+Math.floor(rnd(15));
 await page.mouse.move(fromX,fromY,{steps:5});
 await page.waitForTimeout(100+Math.floor(rnd(80)));
 await page.mouse.down();
 await page.waitForTimeout(60+Math.floor(rnd(40)));
 for(let i=1;i<=steps;i++){
  const t=i/steps,ease=t<0.5?2*t*t:1-Math.pow(-2*t+2,2)/2;
  await page.mouse.move(fromX+(toX-fromX)*ease+(Math.random()-0.5)*3,fromY+(toY-fromY)*ease+(Math.random()-0.5)*3);
  await page.waitForTimeout(6+Math.floor(rnd(12)));
 }
 await page.mouse.move(toX,toY,{steps:3});
 await page.waitForTimeout(150+Math.floor(rnd(100)));
 await page.mouse.up();
 await page.waitForTimeout(200+Math.floor(rnd(100)));
}

// -- screenshots and vision -----------------------------------------------------------------------
async function shotClip(page,clip){
 const vp=page.viewportSize()||{width:1280,height:1000};
 const c={x:Math.max(0,clip.x),y:Math.max(0,clip.y),width:Math.min(clip.width,vp.width-Math.max(0,clip.x)),height:Math.min(clip.height,vp.height-Math.max(0,clip.y))};
 if(c.width<5||c.height<5)return null;
 return page.screenshot({clip:c,scale:'css',type:'png'}).catch(()=>null);
}
let VISION=visionJson; // injectable for tests
async function vision(buf,prompt){
 const r=await VISION(buf,prompt);
 if(r?.declined){DECLINED=true;trace('vision model declined to solve');}
 return r?.json??null;
}
// Which numbered tiles match the instruction; tiles = page rects. 1-based numbers, [] for none, null on failure.
async function pickTiles(page,region,tiles,instruction,label){
 const shot=await shotClip(page,region);if(!shot)return null;
 const centers=tiles.map(t=>({x:t.x-region.x+t.width/2,y:t.y-region.y+t.height/2}));
 const labeled=await annotate(page,shot,{numbers:centers,radius:Math.min(...tiles.map(t=>t.width))/5});
 const prompt=(instruction?`Challenge instruction: "${instruction}"\n\n`:'')+
  `This is a ${label} image challenge with ${tiles.length} tiles, each marked with a red number 1-${tiles.length}. `+
  'Look at each tile carefully. Return ONLY a JSON array of the tile NUMBERS that match the instruction, e.g. [2, 5, 9]. Return [] if none match. Do NOT return coordinates.';
 const j=await vision(labeled,prompt);
 keep(`tiles-${Date.now()}.png`,labeled,{instruction,answer:j});
 if(!j)return null;
 const arr=Array.isArray(j)?j:(j.tiles||j.numbers||[]);
 return [...new Set(arr.map(Number).filter(n=>Number.isInteger(n)&&n>=1&&n<=tiles.length))];
}
async function clickTiles(page,tiles,nums){
 for(const n of nums){const t=tiles[n-1];await humanClick(page,t.x+t.width/2,t.y+t.height/2);await page.waitForTimeout(250+Math.floor(rnd(350)));}
}

// -- reCAPTCHA v2 (checkbox -> audio -> numbered DOM tiles) -----------------------------------------
async function solveRecaptcha(page){
 const anchor=await visibleFrame(page,/recaptcha.*\/anchor/,60,60);
 if(anchor&&!(await recapChecked(page))){await humanClick(page,anchor.box.x+28,anchor.box.y+anchor.box.height/2);await page.waitForTimeout(2500);}
 if(await recapChecked(page)){trace('checkbox passed');return true;}
 const bf=await visibleFrame(page,/recaptcha.*\/bframe/,250,250);
 if(!bf){trace(anchor?'checkbox not passed, no challenge opened':'no reCAPTCHA box or challenge on screen');return false;}
 const bframe=bf.frame;
 // audio first (fast, whisper.cpp on this Mac); Google refuses it to automated browsers, then the grid
 if(await bframe.locator('#recaptcha-audio-button').isVisible().catch(()=>false)){
  const a=await solveRecaptchaAudio(page,{attempts:3,log:m=>trace(m)}).catch(e=>({completed:false,reason:e.message}));
  if(a.completed||(await recapChecked(page))){trace('audio challenge');return true;}
  trace('audio: '+(a.reason||'not accepted'));
  if(await bframe.locator('#recaptcha-image-button').isVisible().catch(()=>false)){await bframe.locator('#recaptcha-image-button').click({timeout:3000}).catch(()=>{});await page.waitForTimeout(2000);}
 }
 return solveRecaptchaGrid(page,bframe);
}
async function solveRecaptchaGrid(page,bframe){
 for(let round=0;round<6;round++){
  if(await recapChecked(page))return true;
  const instruction=await textOf(bframe,'.rc-imageselect-desc-wrapper, .rc-imageselect-desc, .rc-imageselect-desc-no-canonical');
  const fr=await domRects(bframe,'td.rc-imageselect-tile',40);
  const chal=(await domRects(bframe,'.rc-imageselect-challenge',100))[0];
  if(!fr.length||!chal){trace('no image grid in the challenge'+(round?' (round '+round+')':''));return false;}
  const tiles=[];for(const r of fr)tiles.push(await pageRect(page,bframe,r));
  const region=await pageRect(page,bframe,chal);
  const dynamic=/once there are none left|click verify once there are none/i.test(instruction);
  const grid=Math.round(Math.sqrt(tiles.length));
  const vlm=()=>pickTiles(page,region,tiles,instruction,`reCAPTCHA (${grid}x${grid})`);
  // local YOLO first (classifier per tile + COCO segmentation on 4x4); vision only settles the uncertain tiles
  let nums=null,how='vision';
  const shot=await shotClip(page,region);
  const y=shot?await callService('/recaptcha',{image_b64:shot.toString('base64'),label:instruction,grid,
   cells:tiles.map(t=>[Math.max(0,t.x-region.x),Math.max(0,t.y-region.y),t.width,t.height])}):{ok:false};
  if(y.ok){
   nums=y.tiles.slice();how='yolo';
   if(y.uncertain.length||(!nums.length&&grid===3&&!dynamic)){
    const v=await vlm();
    if(v){
     if(!nums.length&&!y.uncertain.length)nums=v;  // the models saw nothing: trust vision
     else nums=[...new Set([...nums,...y.uncertain.filter(n=>v.includes(n))])].sort((a,b)=>a-b);
     how='yolo+vision';
    }
   }
  }else{trace('local model: '+(y.error||'unavailable'));nums=await vlm();}
  keep(`recaptcha-${Date.now()}-${round}.png`,shot,{instruction,grid,nums,how,yolo:y.ok?{tiles:y.tiles,uncertain:y.uncertain,probs:y.probs,cover:y.cover}:y.error});
  trace('image grid ('+how+')');
  if(nums===null)return false;
  await clickTiles(page,tiles,nums);
  if(dynamic&&nums.length){await page.waitForTimeout(3500);continue;}  // replaced tiles fade in: look again
  await page.waitForTimeout(600);
  await bframe.locator('#recaptcha-verify-button').click({timeout:3000}).catch(()=>{});
  await page.waitForTimeout(2500);
  if(await recapChecked(page))return true;
  const again=await safeEval(bframe,()=>[...document.querySelectorAll('.rc-imageselect-incorrect-response, .rc-imageselect-error-select-more, .rc-imageselect-error-dynamic-more, .rc-imageselect-error-select-something')].some(e=>e.offsetParent!==null),undefined,false);
  if(!again&&!(await visibleFrame(page,/recaptcha.*\/bframe/,250,250)))return recapChecked(page);
 }
 return false;
}

// -- hCaptcha (checkbox / invisible -> numbered tiles / canvas points / drag) -------------------------
const DRAG_RE=/drag|move|scale|place the|put the/i;
async function solveHcaptcha(page){
 const t0=Date.now()-1000;
 watchHcapVerdict(page,{trace});
 if(await hcapToken(page))return true;
 if(hcapPassedSince(page,SOLVE_T0)&&!(await hcapChallenge(page)))return true;
 if(await hcapChallenge(page))markOpened(page);  // open before we touched anything = the site's submit opened it
 else{
  const onScreen=b=>b&&b.y>-200&&b.x>-200;
  let cb=null;
  for(const f of framesMatching(page,/hcaptcha/)){
   if(/frame=(enclave|checkbox-invisible|challenge)/.test(f.url()))continue;
   const b=await frameBox(f);
   if(onScreen(b)&&b.width>100&&b.height<150&&b.height>30&&(await frameStyleVisible(f))){cb={frame:f,box:b};break;}
  }
  if(cb){await humanClick(page,cb.box.x+28,cb.box.y+cb.box.height/2);await page.waitForTimeout(3500);}
  else{
   // Invisible hCaptcha: the challenge opens when the site calls hcaptcha.execute(), normally on Submit. Open it the same
   // way; the site's own callback then continues the form as its Submit would. Never on a form with empty visible text
   // boxes unless the site's own Submit already opened a challenge on this page (a rejected round is retried this way).
   const resubmit=siteOpened(page);
   for(const f of scan(page)){
    const opened=await safeEval(f,resubmit=>{
     const w=document.querySelector('.h-captcha[data-size="invisible"], [data-hcaptcha-widget-id], .h-captcha');
     if(!w||!window.hcaptcha||typeof window.hcaptcha.execute!=='function')return false;
     const form=w.closest('form')||document;
     const empty=[...form.querySelectorAll('input[type="email"], input[type="text"], input:not([type])')].filter(i=>i.offsetParent!==null&&!i.value&&!/captcha/i.test(i.name||''));
     if(empty.length&&!resubmit)return 'not-ready';
     try{const id=w.getAttribute('data-hcaptcha-widget-id');id?window.hcaptcha.execute(id):window.hcaptcha.execute();return true;}catch{return false;}
    },resubmit,false);
    if(opened==='not-ready'){trace('invisible hCaptcha left closed: the form still has empty boxes');return false;}
    if(opened){trace('invisible hCaptcha opened');await page.waitForTimeout(4000);break;}
   }
  }
 }
 let lastPrompt='',samePrompt=0,refreshes=0;
 for(let round=0;round<8;round++){
  if(await hcapToken(page))return true;
  const ch=await hcapChallenge(page);
  if(!ch){
   for(let i=0;i<6;i++){if((await hcapToken(page))||hcapPassedSince(page,t0))break;await page.waitForTimeout(500);}
   if(await hcapToken(page))return true;
   if(hcapPassedSince(page,t0)){trace('hCaptcha passed (token handed to the site callback)');return true;}
   return false;
  }
  markOpened(page);
  const {frame,box}=ch;
  const instruction=await textOf(frame,'.prompt-text, .challenge-prompt, h2');
  // the same challenge back = the last answer was wrong; drag puzzles and repeat failures get a fresh challenge
  samePrompt=instruction&&instruction===lastPrompt?samePrompt+1:0;lastPrompt=instruction;
  if(refreshes<4&&((samePrompt>=1&&DRAG_RE.test(instruction))||samePrompt>=2)){
   if(await hcapRefresh(page,frame,box)){refreshes++;samePrompt=0;lastPrompt='';continue;}
  }
  trace('hCaptcha image rounds (vision)');
  const fr=await domRects(frame,'.task-image, .task, .task-grid .image-wrapper',40);
  if(DRAG_RE.test(instruction)){
   if(!(await solveHcaptchaDrag(page,box,instruction)))return false;
  }else if(fr.length>=4){
   const tiles=fr.map(r=>({x:box.x+r.x,y:box.y+r.y,width:r.width,height:r.height}));
   const pattern=/pattern|odd one|doesn.?t belong|does not belong/i.test(instruction);
   const nums=await pickTiles(page,box,tiles,pattern?instruction+' (pick the tiles that break the pattern)':instruction,'hCaptcha');
   if(nums===null)return false;
   await clickTiles(page,tiles,nums);
  }else{
   // canvas challenges ("click on the ...", "click the two similar ..."): measure every candidate, then choose
   const cv=(await domRects(frame,'canvas',150))[0];
   const area=cv?{x:box.x+cv.x,y:box.y+cv.y,width:cv.width,height:cv.height}:box;
   const shot=await shotClip(page,area);if(!shot)return false;
   const gridded=await annotate(page,shot,{grid:50});
   const j=await vision(gridded,`hCaptcha instruction: "${instruction}". A red coordinate grid is drawn over the image (vertical lines labelled with `+
    'their x pixel at the top, horizontal lines with their y pixel at the left, every 50 px). FIRST list EVERY candidate object left to right with its center '+
    'and the property the instruction is about, measured carefully (e.g. for towers / stacks: count the discs or layers one by one; for sizes: compare heights '+
    'in pixels using the grid; for "same / different": describe each shape). THEN choose exactly the object(s) the instruction asks for. Return ONLY JSON '+
    '{"objects": [{"center": [x, y], "property": "..."}], "clicks": [[x, y], ...]} in pixels from the top-left of this image.');
   keep(`point-${Date.now()}.png`,gridded,{instruction,area,answer:j});
   if(!j||!Array.isArray(j.clicks)||!j.clicks.length)return false;
   trace('hCaptcha point task (grid-guided vision)');
   for(const [x,y] of j.clicks){await humanClick(page,area.x+x,area.y+y);await page.waitForTimeout(350+rnd(300));}
  }
  await page.waitForTimeout(700);
  const btn=(await domRects(frame,'.button-submit, button[type="submit"], .challenge-submit',10))[0];
  if(btn)await humanClick(page,box.x+btn.x+btn.width/2,box.y+btn.y+btn.height/2);
  await page.waitForTimeout(2500);
 }
 return hcapToken(page);
}
async function solveHcaptchaDrag(page,box,instruction){
 const shot=await shotClip(page,box);if(!shot)return false;
 const gridded=await annotate(page,shot,{grid:50});
 const j=await vision(gridded,`hCaptcha drag puzzle: "${instruction}". A red coordinate grid is drawn over the image: vertical lines are labelled `+
  'with their x pixel at the top, horizontal lines with their y pixel at the left (every 50 px). Decide which piece(s) must be dragged and exactly where '+
  '(e.g. the animal whose silhouette matches an outline; only the correct piece moves). Use the grid to give precise pixel coordinates. '+
  'Return ONLY JSON {"drags": [{"from": [x1, y1], "to": [x2, y2]}]}: "from" = center of the piece to drag, "to" = center of the matching outline/target.');
 keep(`drag-${Date.now()}.png`,gridded,{instruction,box,answer:j});
 const drags=j&&(j.drags||j.clicks);
 if(!Array.isArray(drags)||!drags.length||!drags[0].from)return false;
 for(const d of drags){await humanDragTo(page,box.x+d.from[0],box.y+d.from[1],box.x+d.to[0],box.y+d.to[1]);await page.waitForTimeout(600+Math.floor(rnd(400)));}
 trace('hCaptcha drag (grid-guided vision)');
 return true;
}
async function hcapRefresh(page,frame,box){
 const r=(await domRects(frame,'.refresh.button, [aria-label^="Refresh Challenge"]',10))[0];
 if(!r)return false;
 await humanClick(page,box.x+r.x+r.width/2,box.y+r.y+r.height/2);
 await page.waitForTimeout(2500);
 trace('hCaptcha refreshed for a new challenge');
 return true;
}

// -- Cloudflare: Turnstile widget + the "Just a moment..." interstitial ------------------------------
// ask Turnstile itself for a fresh token: interaction-only widgets are display:none and expired tokens are not renewed
// by a click; reset() re-runs the check, execute() runs an execute-mode widget the site would run on Submit
async function turnstileRefresh(page){
 let did=false;
 for(const f of scan(page))did=(await safeEval(f,()=>{if(!window.turnstile||typeof window.turnstile.reset!=='function')return false;try{window.turnstile.reset();}catch{}return true;},undefined,false))||did;
 if(!did)return false;
 trace('Turnstile refreshed via its API');
 for(let i=0;i<10;i++){await page.waitForTimeout(1000);if((await tsToken(page))>10)return true;}
 let ex=false;
 for(const f of scan(page))ex=(await safeEval(f,()=>{
  if(!window.turnstile||typeof window.turnstile.execute!=='function')return false;
  const ids=[...document.querySelectorAll('input[id^="cf-chl-widget-"][id$="_response"]')].filter(e=>!(e.value||'').length).map(e=>e.id.replace(/_response$/,''));
  let n=0;for(const id of ids){try{window.turnstile.execute(id);n++;}catch{}}
  if(!n)for(const h of document.querySelectorAll('.cf-turnstile, [data-sitekey][class*="turnstile"]')){try{window.turnstile.execute(h);n++;}catch{}}
  return n>0;
 },undefined,false))||ex;
 if(!ex)return false;
 trace('Turnstile executed via its API');
 for(let i=0;i<20;i++){await page.waitForTimeout(1000);if((await tsToken(page))>10)return true;}
 return false;
}
async function turnstileBox(page){
 const f=await visibleFrame(page,/challenges\.cloudflare\.com/,100,30);
 if(f)return f.box;
 for(const fr of scan(page)){
  const r=(await domRects(fr,'.cf-turnstile, [data-sitekey][class*="turnstile"], #cf-turnstile, #turnstile-wrapper, #turnstile-container, .main-content #challenge-stage',30))[0];
  if(r)return pageRect(page,fr,r);
 }
 return null;
}
async function solveTurnstile(page){
 for(let i=0;i<6;i++){if(await tsToken(page)>10){trace('auto-pass');return true;}await page.waitForTimeout(1000);}
 if(await turnstileRefresh(page))return true;
 let clicks=0;
 for(let attempt=0;attempt<3;attempt++){
  const b=await turnstileBox(page);
  if(!b){if(!clicks)trace('no Turnstile box on screen to click');return (await tsToken(page))>10;}
  await humanClick(page,b.x+Math.min(30,b.width/2),b.y+b.height/2);clicks++;
  for(let i=0;i<8;i++){await page.waitForTimeout(1000);if(await tsToken(page)>10){trace('checkbox click');return true;}}
 }
 if(clicks)trace(`Turnstile box clicked ${clicks}x, no token`);
 return (await tsToken(page))>10;
}
async function solveCfInterstitial(page,maxMs=25000){
 trace('Cloudflare interstitial wait');
 const t0=Date.now();
 const still=()=>safeEval(page.mainFrame(),()=>/^just a moment/i.test(document.title)||!!document.querySelector('#challenge-running, #challenge-stage, #challenge-form, #cf-challenge-running'),undefined,false);
 while(Date.now()-t0<maxMs){
  await page.waitForTimeout(1500);
  if(!(await still()))return true;
  const b=await turnstileBox(page);
  if(b&&Date.now()-t0>4000){await humanClick(page,b.x+Math.min(30,b.width/2),b.y+b.height/2);await page.waitForTimeout(4000);}
 }
 return !(await still());
}

// -- PerimeterX / HUMAN "Press & Hold" --------------------------------------------------------------
async function solvePressHold(page){
 let b=null;
 for(const fr of scan(page)){const r=(await domRects(fr,'#px-captcha',30))[0];if(r){b=await pageRect(page,fr,r);break;}}
 if(!b)return false;
 const x=b.x+b.width/2+(Math.random()-0.5)*20,y=b.y+b.height/2+(Math.random()-0.5)*6;
 await page.mouse.move(x-60,y+30,{steps:5});await page.mouse.move(x,y,{steps:8});
 await page.waitForTimeout(150+rnd(200));
 await page.mouse.down();trace('press and hold');
 const t0=Date.now();
 const gone=()=>page.locator('#px-captcha').first().isVisible().then(v=>!v).catch(()=>true);
 while(Date.now()-t0<15000){
  await page.waitForTimeout(500);
  await page.mouse.move(x+(Math.random()-0.5)*2,y+(Math.random()-0.5)*2);
  const done=await safeEval(page.mainFrame(),()=>/verified|thank you|access granted/i.test((document.body||{}).innerText||''),undefined,false);
  if((await gone())||done||Date.now()-t0>11000)break;
 }
 await page.mouse.up();
 await page.waitForTimeout(3000);
 return gone();
}

// -- Proof-of-work widgets (Friendly Captcha, ALTCHA, mCaptcha) --------------------------------------
async function solveProofOfWork(page){
 trace('proof of work');
 for(const fr of scan(page)){
  const btn=(await domRects(fr,'.frc-captcha button.frc-button, altcha-widget input[type="checkbox"], .altcha input[type="checkbox"], #widget__verification-checkbox, .mcaptcha input[type="checkbox"]',8))[0];
  if(btn){const r=await pageRect(page,fr,btn);if(r)await humanClick(page,r.x+r.width/2,r.y+r.height/2);}
 }
 for(let i=0;i<40;i++){  // the browser does the work; it takes a few seconds
  await page.waitForTimeout(1000);
  if(await anyFrame(page,()=>{
   const frc=document.querySelector('input[name="frc-captcha-solution"], input[name="frc-captcha-response"]');
   const alt=document.querySelector('altcha-widget, .altcha');
   return !!(document.querySelector('.frc-success')||(frc&&frc.value&&!frc.value.startsWith('.'))||
    (alt&&/verified/i.test(alt.getAttribute('data-state')||alt.getAttribute('state')||''))||
    [...document.querySelectorAll('input[name="altcha"], input[name="mcaptcha__token"]')].some(e=>(e.value||'').length>10));
  }))return true;
 }
 return false;
}

// -- Text-image CAPTCHA (OCR ensemble: ddddocr x2 + vision x2, majority wins) -------------------------
async function solveTextImage(page){
 for(const fr of scan(page)){
  const found=await safeEval(fr,()=>{
   const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
   const capSig=e=>{let p='';try{p=e.src&&!/^data:/.test(e.src)?new URL(e.src).pathname:'';}catch{}
    return (p+' '+e.id+' '+(typeof e.className==='string'?e.className:'')+' '+(e.alt||'')+' '+(e.getAttribute('name')||'')).toLowerCase();};
   const painted=e=>/url\(/.test(getComputedStyle(e).backgroundImage||'');
   const imgs=[...document.querySelectorAll('img, canvas, div[id*="captcha" i], div[class*="captcha" i], div[id*="mtcap" i], span[class*="captcha" i]')]
    .filter(e=>(e.tagName==='IMG'||e.tagName==='CANVAS'||painted(e))).filter(e=>{const s=capSig(e),r=e.getBoundingClientRect();
     return /captcha|mtcap|securimage|kcaptcha|verif\w*[-_ ]?code|security[-_ ]?code/.test(s)&&!/recaptcha|hcaptcha/.test(s)&&!/\.svg(\?|$)/.test(e.src||'')&&r.width>=50&&r.height>=18&&r.height<=220;});
   const inp=[...document.querySelectorAll('input')].find(i=>vis(i)&&!i.value&&(i.type==='text'||!i.type)&&/captcha|mtcap|security.?code|verification.?code|characters|code.*(image|shown|above)|text (from|in|on) (the )?(image|picture)|type the (text|characters|code)|enter (the )?(code|text) shown/i
    .test((i.name||'')+' '+(i.id||'')+' '+(i.placeholder||'')+' '+(i.getAttribute('aria-label')||'')));
   if(!inp||!imgs.length)return null;
   const c=e=>{const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2];};
   const [ix,iy]=c(inp),dist=e=>{const [x,y]=c(e);return Math.hypot(x-ix,y-iy);};
   const img=imgs.sort((a,b)=>dist(a)-dist(b))[0];
   if(dist(img)>420)return null;
   inp.setAttribute('data-captcha-answer','1');
   const r=img.getBoundingClientRect();
   return {x:r.x,y:r.y,width:r.width,height:r.height};
  },undefined,null);
  if(!found)continue;
  const r=await pageRect(page,fr,found);const shot=r&&await shotClip(page,r);
  if(!shot)return false;
  const P='This image is a distorted text CAPTCHA. Read it character by character, left to right (case-sensitive; letters and digits only, no spaces). '+
   'If instead it shows an arithmetic question, reply {"math": true}. Reply ONLY with JSON {"text": "..."}.';
  const [o,v1]=await Promise.all([callService('/ocr',{image_b64:shot.toString('base64')},{timeoutMs:30000}),vision(shot,P)]);
  if(v1&&v1.math){trace('arithmetic CAPTCHA: not answered (policy)');return false;}
  const norm=x=>String(x||'').replace(/[^0-9A-Za-z]/g,'');
  const cands=[v1&&norm(v1.text),o.ok&&norm(o.text),o.ok&&norm(o.alt||o.text)].filter(x=>x&&x.length>=3);
  const tally={};for(const c of cands)tally[c.toLowerCase()]=(tally[c.toLowerCase()]||0)+1;
  const top=Object.entries(tally).sort((a,b)=>b[1]-a[1])[0];
  let pick=null;
  if(top&&top[1]>=2)pick={text:cands.find(c=>c.toLowerCase()===top[0]),by:'vote '+top[1]+'/'+cands.length};
  else if(cands.length)pick={text:cands[0],by:'best single ('+(v1?'vision':'ddddocr')+')'};
  keep(`ocr-${Date.now()}.png`,shot,{cands,pick});
  if(!pick||!pick.text)return false;
  trace('OCR '+pick.by);
  const inp=fr.locator('[data-captcha-answer="1"]').first();
  await inp.click().catch(()=>{});
  await inp.pressSequentially(String(pick.text).replace(/\s+/g,''),{delay:90+rnd(60)}).catch(()=>{});
  await inp.press('Tab').catch(()=>{});  // MTCaptcha and most widgets check the answer on blur
  await inp.evaluate(e=>e.removeAttribute('data-captcha-answer')).catch(()=>{});
  return true;
 }
 return false;
}

// -- Sliders in any frame (DataDome, GeeTest, generic) -------------------------------------------------
async function slideOffset(bgB64,pieceB64){
 if(!bgB64||!pieceB64)return {ok:false};
 const s=await callService('/slide',{bg:bgB64,piece:pieceB64},{timeoutMs:30000});
 return s.ok&&typeof s.x==='number'?{ok:true,x_offset:s.x,confidence:s.conf,method:'local:'+s.method}:{ok:false,error:s.error};
}
const HANDLE_SEL='.geetest_btn, .geetest_slider_button, .sliderIcon, .slider-icon, [class*="slider"] [class*="handle"], [class*="slider"][class*="btn"], [class*="slider-button"], [class*="drag"][class*="btn"], [class*="handler"], [role="slider"], .slider .knob, #captcha__puzzle ~ * [class*="slider"]';
// The slider must live inside a CAPTCHA container (a DataDome frame is all CAPTCHA, so null there); never a range slider of the form.
const SLIDER_ROOT='.geetest_box, .geetest_holder, .geetest_panel, .geetest_panel_box, [class*="slider"][class*="captcha"], [id*="slider"][id*="captcha"], .slider-captcha, .sliderContainer, [class*="captcha"][class*="slide"], [class*="puzzle"][class*="slide"], #captcha__puzzle, [class*="tcaptcha"]';
async function solveSliderInFrame(page,frame,rootSel=SLIDER_ROOT){
 const info=await safeEval(frame,({HANDLE_SEL,rootSel})=>{
  const vis=e=>{const r=e.getBoundingClientRect();return r.width>10&&r.height>10;};
  const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
  let root=document;
  if(rootSel){
   let r=[...document.querySelectorAll(rootSel)].find(vis);
   if(!r)return null;
   for(let i=0;i<4&&r.parentElement&&!(r.querySelector(HANDLE_SEL)&&r.querySelector('img, canvas, [style*="background"]'));i++)r=r.parentElement;
   root=r;
  }
  const handle=[...root.querySelectorAll(HANDLE_SEL)].find(vis);
  if(!handle)return null;
  const bgUrl=e=>{const m=getComputedStyle(e).backgroundImage.match(/url\(["']?(.*?)["']?\)/);return m?m[1]:null;};
  const els=[...root.querySelectorAll('img, canvas, div, span')].filter(e=>vis(e)&&(e.tagName==='IMG'||e.tagName==='CANVAS'||bgUrl(e)));
  const data=e=>{
   try{
    if(e.tagName==='CANVAS')return {b64:e.toDataURL('image/png').split(',')[1],natW:e.width};
    if(e.tagName==='IMG'){const c=document.createElement('canvas');c.width=e.naturalWidth;c.height=e.naturalHeight;c.getContext('2d').drawImage(e,0,0);return {b64:c.toDataURL('image/png').split(',')[1],natW:e.naturalWidth};}
   }catch{}
   return {url:e.tagName==='IMG'?e.src:bgUrl(e),natW:e.tagName==='IMG'?e.naturalWidth:0};
  };
  const sorted=els.map(e=>({e,r:rect(e)})).sort((a,b)=>b.r.width*b.r.height-a.r.width*a.r.height);
  const bg=sorted[0];
  const piece=bg&&sorted.find(c=>c!==bg&&c.r.width<bg.r.width*0.45&&c.r.height<=bg.r.height*1.05&&c.r.height>bg.r.height*0.15&&c.r.y>=bg.r.y-5&&c.r.y+c.r.height<=bg.r.y+bg.r.height+5);
  return {handle:rect(handle),bg:bg&&{...bg.r,...data(bg.e)},piece:piece&&{...piece.r,...data(piece.e)}};
 },{HANDLE_SEL,rootSel},null);
 if(!info)return false;
 const handle=await pageRect(page,frame,info.handle);if(!handle)return false;
 const load=async x=>x.b64||(x.url?await page.request.get(new URL(x.url,frame.url()).href).then(r=>r.body()).then(b=>b.toString('base64')).catch(()=>null):null);
 let dist=null;
 if(info.bg&&info.piece){
  const [bgB,pcB]=[await load(info.bg),await load(info.piece)];
  if(bgB&&pcB){
   const res=await slideOffset(bgB,pcB);
   if(res.ok&&res.x_offset!=null&&(res.confidence==null||res.confidence>0.25)){
    const scale=info.bg.natW?info.bg.width/info.bg.natW:1;
    dist=Math.round(res.x_offset*scale-(info.piece.x-info.bg.x));
    trace('slider ('+res.method+')');
   }
  }
 }
 if(dist==null||dist<5){
  const region=await pageRect(page,frame,info.bg||{x:info.handle.x-20,y:info.handle.y-180,width:340,height:220});
  const shot=region&&await shotClip(page,region);
  if(!shot)return false;
  const j=await vision(shot,'This is a slider-puzzle CAPTCHA. Return ONLY JSON {"gap_x": <x of the LEFT edge of the empty slot>, "piece_x": <x of the LEFT edge of the movable puzzle piece>} in pixels from the left of this image.');
  if(!j||typeof j.gap_x!=='number')return false;
  dist=Math.round(j.gap_x-(typeof j.piece_x==='number'?j.piece_x:0));
  trace('slider (vision)');
 }
 if(!(dist>3))return false;
 await humanDrag(page,handle.x+handle.width/2,handle.y+handle.height/2,dist);
 await page.waitForTimeout(2000);
 return true;
}
const gtPassed=page=>anyFrame(page,()=>!!document.querySelector('[class*="geetest_success"], .geetest_lock_success, .geetest_radar_success'));
async function solveGeetest(page){
 for(let attempt=0;attempt<3;attempt++){
  if(await gtPassed(page))return true;
  for(const fr of scan(page)){
   const open=(await domRects(fr,'.geetest_btn_click, .geetest_radar_tip, .geetest_radar_btn',20))[0];
   const shown=await safeEval(fr,()=>!!document.querySelector('.geetest_boxShow, .geetest_panel_box, .geetest_widget'),undefined,false);
   if(open&&!shown){const r=await pageRect(page,fr,open);if(r){await humanClick(page,r.x+r.width/2,r.y+r.height/2);await page.waitForTimeout(3000);}}
   if(await gtPassed(page))return true;
   if(await solveSliderInFrame(page,fr)){if(await gtPassed(page))return true;continue;}
   // click-in-order / icon / nine-grid: vision on the challenge box, then its confirm button
   const box=(await domRects(fr,'.geetest_box, .geetest_panel_box, .geetest_widget',150))[0];
   if(box){
    const r=await pageRect(page,fr,box);const shot=r&&await shotClip(page,r);
    const tip=await textOf(fr,'.geetest_text_tips, .geetest_tip_content, .geetest_title');
    const j=shot&&await vision(shot,`This is a GeeTest CAPTCHA. Instruction: "${tip}". Read any example icons/characters it shows. `+
     'Return ONLY JSON {"clicks": [[x, y], ...]}: the points to click IN ORDER, in pixels from the top-left of this image (not the confirm button).');
    if(j&&Array.isArray(j.clicks)&&j.clicks.length){
     for(const [x,y] of j.clicks){await humanClick(page,r.x+x,r.y+y);await page.waitForTimeout(500+rnd(300));}
     const ok=(await domRects(fr,'.geetest_submit, .geetest_commit, .geetest_btn_submit',10))[0];
     if(ok){const o=await pageRect(page,fr,ok);if(o)await humanClick(page,o.x+o.width/2,o.y+o.height/2);}
     await page.waitForTimeout(2500);
     if(await gtPassed(page))return true;
    }
   }
  }
  for(const fr of scan(page)){const rf=(await domRects(fr,'.geetest_refresh, .geetest_refresh_1',10))[0];if(rf){const r=await pageRect(page,fr,rf);if(r){await humanClick(page,r.x+r.width/2,r.y+r.height/2);await page.waitForTimeout(2000);}break;}}
 }
 return gtPassed(page);
}

// -- AWS WAF / Arkose / unrecognised puzzles (vision, best effort) --------------------------------------
async function solveVisionPuzzle(page,frame,sel,label){
 const rr=(await domRects(frame,sel,120))[0];if(!rr)return false;
 const box=await pageRect(page,frame,rr);const shot=box&&await shotClip(page,box);
 if(!shot)return false;
 const j=await vision(shot,`This is a ${label} CAPTCHA. Read its instruction in the image and solve it. Return ONLY JSON {"clicks": [[x, y], ...]}: `+
  'pixel points to click from the top-left of this image (image tiles or objects to select; NOT the confirm/submit button).');
 if(!j||!Array.isArray(j.clicks)||!j.clicks.length)return false;
 for(const [x,y] of j.clicks){await humanClick(page,box.x+x,box.y+y);await page.waitForTimeout(350+rnd(300));}
 const btn=frame.locator(`${sel} button, button`).filter({hasText:/confirm|verify|submit|next|continue/i}).first();
 if(await btn.isVisible().catch(()=>false)){const b=await btn.boundingBox();if(b)await humanClick(page,b.x+b.width/2,b.y+b.height/2);}
 await page.waitForTimeout(2500);
 return true;
}
async function solveArkose(page){
 trace('Arkose vision rounds');
 for(let round=0;round<10;round++){
  let game=null;
  for(const f of framesMatching(page,/arkoselabs|funcaptcha/)){const b=await frameBox(f);if(b&&b.width>250&&b.height>250&&(!game||b.width*b.height<=game.box.width*game.box.height))game={frame:f,box:b};}
  if(!game)return round>0;
  const shot=await shotClip(page,game.box);if(!shot)return false;
  const j=await vision(shot,'This is an Arkose Labs (FunCaptcha) challenge round. Read the instruction in the image. Return ONLY JSON: '+
   '{"clicks": [[x, y], ...]}: every click needed to answer THIS round in order (e.g. the matching image, or an arrow button pressed N times, '+
   'then the Submit/Verify button if there is one), pixel points from the top-left of this image; or {"done": true} if the image shows the challenge is complete.');
  if(!j)return false;
  if(j.done)return true;
  if(!Array.isArray(j.clicks)||!j.clicks.length)return false;
  for(const [x,y] of j.clicks){await humanClick(page,game.box.x+x,game.box.y+y);await page.waitForTimeout(450+rnd(350));}
  await page.waitForTimeout(2500);
 }
 return false;
}
async function solveWithVision(page,el){
 const box=await el.boundingBox().catch(()=>null);const shot=box&&await shotClip(page,box);
 if(!shot)return false;
 const promptText=await el.evaluate(e=>{const p=e.querySelector('h2, h3, .prompt, .instruction, [class*="prompt"], [class*="instruction"]');return p?p.innerText:'';}).catch(()=>'');
 const j=await vision(shot,`Solve this CAPTCHA${promptText?' ("'+promptText+'")':''}. Return ONLY JSON {"clicks": [[x, y], ...]} (points from the top-left of this image) or {"x_offset": <pixels to drag the slider>}.`);
 if(!j)return false;
 if(Array.isArray(j.clicks)&&j.clicks.length){for(const [x,y] of j.clicks){await humanClick(page,box.x+x,box.y+y);await page.waitForTimeout(400+rnd(300));}return true;}
 if(typeof j.x_offset==='number'){
  const h=await el.locator('[class*="drag"], [class*="handle"], [class*="slider"], [role="slider"]').first().boundingBox().catch(()=>null);
  if(h){await humanDrag(page,h.x+h.width/2,h.y+h.height/2,j.x_offset);return true;}
 }
 return false;
}

// -- orchestration ---------------------------------------------------------------------------------
export const SOLVERS={
 'cloudflare/interstitial':p=>solveCfInterstitial(p),
 'perimeterx/press-and-hold':p=>solvePressHold(p),
 'recaptcha/checkbox':p=>solveRecaptcha(p),
 'recaptcha/challenge':p=>solveRecaptcha(p),
 'turnstile/widget':p=>solveTurnstile(p),
 'hcaptcha/checkbox':p=>solveHcaptcha(p),
 'hcaptcha/challenge':p=>solveHcaptcha(p),
 'hcaptcha/invisible':p=>solveHcaptcha(p),
 'friendly-captcha/proof-of-work':p=>solveProofOfWork(p),
 'altcha/proof-of-work':p=>solveProofOfWork(p),
 'mcaptcha/proof-of-work':p=>solveProofOfWork(p),
 'datadome/slider':async p=>{for(const f of framesMatching(p,/captcha-delivery\.com/))if(await solveSliderInFrame(p,f,null))return true;return false;},
 'geetest/challenge':p=>solveGeetest(p),
 'slider/slider':async p=>{for(const f of scan(p))if(await solveSliderInFrame(p,f))return true;return false;},
 'aws-waf/challenge':async p=>{for(const f of scan(p))if(await solveVisionPuzzle(p,f,'awswaf-captcha, #captcha-container','AWS WAF'))return true;return false;},
 'arkose/game':p=>solveArkose(p),
 'mtcaptcha/text-image':async p=>{const ok=await solveTextImage(p);for(let i=0;ok&&i<8&&!(await mtcapVerified(p));i++)await p.waitForTimeout(750);return ok;},
 'text-image/ocr':p=>solveTextImage(p),
};
// order: interstitials first (they hide everything else), then interactive widgets
export const ORDER=['cloudflare/interstitial','perimeterx/press-and-hold','recaptcha/checkbox','recaptcha/challenge','turnstile/widget',
 'hcaptcha/checkbox','hcaptcha/challenge','hcaptcha/invisible','friendly-captcha/proof-of-work','altcha/proof-of-work','mcaptcha/proof-of-work',
 'datadome/slider','geetest/challenge','slider/slider','aws-waf/challenge','arkose/game','mtcaptcha/text-image','text-image/ocr'];

// Is anything still unsolved? (a token present, or the widget gone, means solved)
export async function stillThere(page,key,{identifyImpl=identify}={}){
 if(/^recaptcha/.test(key))return !(await recapChecked(page))&&(!!(await visibleFrame(page,/recaptcha.*\/anchor/,60,60))||!!(await visibleFrame(page,/recaptcha.*\/bframe/,250,250)));
 if(/^hcaptcha/.test(key)&&hcapPassedSince(page,Date.now()-120000)&&!(await hcapChallenge(page)))return false;
 if(/^hcaptcha/.test(key))return !(await hcapToken(page))&&(!!(await hcapChallenge(page))||framesMatching(page,/hcaptcha/).length>0);
 if(/^turnstile/.test(key))return (await tsToken(page))<=10&&(framesMatching(page,/challenges\.cloudflare\.com/).length>0||!!(await turnstileBox(page)));
 return (await identifyImpl(page)).some(v=>v.vendor+'/'+v.kind===key);
}

const HUMAN_CHECK=/verify (that )?you are (a )?human|complete the (security|human) check|i'?m not a robot|prove you('re| are) human|security check/i;
async function solveVendors(page,{maxAttempts=3,identifyImpl=identify,solvers=SOLVERS,still=(p,k)=>stillThere(p,k,{identifyImpl}),wait=ms=>page.waitForTimeout(ms)}={}){
 let vendors=await identifyImpl(page);
 const done=(extra)=>({vendors,vendorText:vendorText(vendors),...extra});
 if(isWall(vendors))return done({solved:false,type:'antibot-wall',wall:true,attempts:0});
 const policy=vendors.find(v=>v.vendor==='math');
 const todo=ORDER.filter(k=>vendors.some(v=>v.vendor+'/'+v.kind===k));
 if(!todo.length){
  const main=typeof page.mainFrame==='function'?page.mainFrame():null;
  const txt=main?await safeEval(main,()=>(document.body.innerText||'').slice(0,5000),undefined,''):'';
  if(HUMAN_CHECK.test(txt)){  // unrecognised: a "verify you are human" text over some puzzle -> vision fallback
   for(let a=1;a<=maxAttempts;a++){
    const el=page.locator('[class*="captcha"], [id*="captcha"], [class*="challenge"], [class*="verify"]').first();
    if(!(await el.isVisible().catch(()=>false)))break;
    await solveWithVision(page,el);await wait(1500);
    if(DECLINED)break;
    const t2=await safeEval(main,()=>(document.body.innerText||'').slice(0,5000),undefined,'');
    if(!HUMAN_CHECK.test(t2))return done({solved:true,type:'vision-fallback',attempts:a});
   }
   return done({solved:false,type:'unidentified',attempts:maxAttempts,declined:DECLINED});
  }
  if(!policy&&vendors.some(v=>v.kind==='solved')&&!vendors.some(v=>v.solvable))return done({solved:true,type:'already-solved',attempts:0});
  const nothing=vendors.every(v=>!v.solvable);
  return done({solved:false,type:policy?'math-policy':nothing&&vendors.length?'not-solvable':'none',attempts:0,...(policy?{policy:policy.note}:{})});
 }
 for(const key of todo){
  for(let a=1;a<=maxAttempts;a++){
   await solvers[key](page).catch(e=>trace(key+' threw: '+String(e?.message??e).slice(0,80)));
   await wait(1200);
   if(!(await still(page,key)))break;
   if(DECLINED){vendors=await identifyImpl(page);return done({solved:false,declined:true,type:key,attempts:a});}
   if(a===maxAttempts){vendors=await identifyImpl(page);return done({solved:false,type:key,attempts:a});}
  }
 }
 vendors=await identifyImpl(page);
 const left=vendors.filter(v=>v.solvable&&v.vendor!=='cloudflare');
 const open=[];
 for(const v of left)if(await still(page,v.vendor+'/'+v.kind))open.push(v);
 return done({solved:!open.length&&!policy,type:todo.join('+'),attempts:1,...(policy?{policy:policy.note}:{})});
}

// Evidence for a miss: page screenshot, each CAPTCHA frame's text and token state, console lines heard.
async function missEvidence(page,heard){
 const d=dbgDir();if(!d)return;
 try{mkdirSync(d,{recursive:true});}catch{return;}
 await page.screenshot({path:join(d,'miss-page.png'),fullPage:false}).catch(()=>{});
 const frames=[];
 for(const f of scan(page)){
  const u=f.url();
  if(!/recaptcha|hcaptcha|captcha/i.test(u)&&f!==page.mainFrame())continue;
  const info=await safeEval(f,()=>{
   const ts=[];try{for(const e of document.querySelectorAll('input[id^="cf-chl-widget-"], [name="cf-turnstile-response"], [name="g-recaptcha-response"], [name="h-captcha-response"]'))ts.push((e.id||e.name)+':'+(e.value||'').length);}catch{}
   return {text:(document.body?document.body.innerText:'').replace(/\s+/g,' ').slice(0,300),inputs:ts};
  },undefined,{});
  frames.push({url:u.slice(0,160),box:await frameBox(f),...info});
 }
 try{writeFileSync(join(d,'miss.json'),JSON.stringify({at:new Date().toISOString(),page:page.url(),trace:TRACE,heard,frames},null,1));}catch{}
}

export function encounterRecord(r,{page,company,role,url,worker,secs}){
 let host='';try{host=new URL(page.url()).host;}catch{}
 return {ts:new Date().toISOString(),company:company||null,role:role||null,job:url||null,worker:worker||null,host,
  vendors:[...new Set([...String(r.type||'').split('+').filter(x=>/^[a-z-]+\/[a-z-]+$/.test(x)),
   ...(r.vendors||[]).filter(v=>v.kind!=='solved').map(v=>v.vendor+'/'+v.kind),
   ...(r.type==='already-solved'?(r.vendors||[]).map(v=>v.vendor+'/'+v.kind):[])])],
  solved:!!r.solved,type:r.type,how:r.how,attempts:r.attempts,secs,wall:!!r.wall,policy:r.policy||null,declined:!!r.declined,
  shots:(()=>{try{const d=dbgDir();return d&&existsSync(d)?relative(ROOT,d):null;}catch{return null;}})()};
}

// Solve whatever CAPTCHA the page shows. Returns {solved, type, vendors, vendorText, how, wall, declined, policy, attempts}.
export async function solveCaptchaLocally(page,{company,role,url,maxAttempts=3,log=()=>{},vision:visionImpl,identifyImpl,solvers,wait}={}){
 const t0=Date.now();SOLVE_T0=t0;TRACE=[];DECLINED=false;newDbg(company);
 if(visionImpl)VISION=visionImpl;else VISION=visionJson;
 const heard=[];
 const onConsole=m=>{try{const t=m.text();if(/turnstile|captcha|cloudflare|error code|challenge/i.test(t))heard.push(t.slice(0,200));}catch{}};
 try{page.on('console',onConsole);}catch{}
 let r;
 try{
  // a cookie-consent veil over the page swallows every tile click / drag
  try{const c=await dismissConsent(page);if(c.length)trace('cookie banner closed');}catch{}
  r=await solveVendors(page,{maxAttempts,identifyImpl,solvers,wait});
 }catch(e){r={solved:false,type:'error',error:String(e?.message??e).slice(0,160),vendors:[],vendorText:'error'};}
 try{page.off('console',onConsole);}catch{}
 for(const h of heard){const code=h.match(/error code:?\s*(\d{3,6})/i);if(code)trace('widget error '+code[1]);}
 if(!r.solved&&!r.wall&&r.type!=='none')await missEvidence(page,heard).catch(()=>{});
 r.how=[...new Set(TRACE)].join(', ');
 r.secs=Math.round((Date.now()-t0)/100)/10;
 if(process.env.CAPTCHA_LOG!=='0'&&r.type!=='none'){
  try{mkdirSync(dirname(LOG_FILE()),{recursive:true});appendFileSync(LOG_FILE(),JSON.stringify(encounterRecord(r,{page,company,role,url,worker:process.env.APPLICATION_WORKER,secs:r.secs}))+'\n');}catch{}
  await log(`Local CAPTCHA solver: ${r.solved?'solved':'did not solve'} ${r.vendorText} (${r.how||r.error||r.type})`);
 }
 return r;
}

// The page looks like a bot check. A wall -> {wall:true} (never retried from here). A challenge
// (Cloudflare interstitial, press-and-hold, DataDome / any CAPTCHA) -> wait for the auto-pass and
// solve it; cleared when the page no longer looks like a bot check.
export async function clearChallenge(page,{maxMs=45000,solve=solveCaptchaLocally,identifyImpl=identify,log=()=>{}}={}){
 const t0=Date.now();
 const bodyText=()=>safeEval(page.mainFrame(),()=>(document.body?document.body.innerText:'').slice(0,4000),undefined,'');
 let vendors=await identifyImpl(page);
 if(isWall(vendors))return {cleared:false,wall:true,vendors,vendorText:vendorText(vendors)};
 let last=null;
 while(Date.now()-t0<maxMs){
  last=await solve(page,{maxAttempts:2,log});
  if(last.wall)return {cleared:false,wall:true,vendors:last.vendors,vendorText:last.vendorText};
  await page.waitForLoadState('domcontentloaded',{timeout:8000}).catch(()=>{});
  await page.waitForTimeout(1500);
  const throttled=siteThrottled(await bodyText());
  vendors=await identifyImpl(page);
  if(!throttled&&!vendors.some(v=>v.solvable&&v.kind!=='invisible'))return {cleared:true,by:last.type,vendors,vendorText:vendorText(vendors),secs:Math.round((Date.now()-t0)/1000)};
  if(isWall(vendors))return {cleared:false,wall:true,vendors,vendorText:vendorText(vendors)};
 }
 return {cleared:false,wall:false,vendors,vendorText:vendorText(vendors),by:last&&last.type};
}

export const _internals={solveRecaptcha,solveRecaptchaGrid,solveHcaptcha,solveTurnstile,solveCfInterstitial,solvePressHold,solveProofOfWork,solveTextImage,solveSliderInFrame,solveGeetest,solveArkose,pickTiles,shotClip,solveVendors};
