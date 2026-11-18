// Names every bot check on a page: vendor + kind + whether it can be solved here. Widgets are found
// through page.frames() (an iframe nested inside another iframe, as iCIMS renders its hCaptcha, is
// invisible to top-level locators) and placed with the frame element's box. A true wall (Akamai,
// Kasada, Incapsula, DataDome hard block, 403) is never solved; score-only reCAPTCHA v3 has nothing
// to click; a widget already holding its token is reported solved, not as work to do.
//
// Never run code inside Cloudflare's challenge frame: Turnstile notices script evaluated in it and
// fails the check (error 600010). The token lives in the host page, so the frame is only found by
// its URL and placed by its element's box.

export const CF_FRAME=/challenges\.cloudflare\.com/;
export const scan=page=>page.frames().filter(f=>!CF_FRAME.test(f.url()));
export const mainOf=page=>typeof page.mainFrame==='function'?page.mainFrame():null;
export const framesMatching=(page,re)=>page.frames().filter(f=>f!==mainOf(page)&&re.test(f.url()));
// frame.evaluate that tolerates detached frames and fakes in tests
export async function safeEval(frame,fn,arg,fallback=null){try{return await frame.evaluate(fn,arg);}catch{return fallback;}}

// a frame's iframe box relative to the main viewport (nested frames and closed shadow roots too); a
// visible frame that sits off-screen is scrolled into view with a short timeout (a hidden iframe,
// such as an hCaptcha challenge frame before it opens, would otherwise wait out Playwright's 30 s).
export async function frameBox(frame){
 try{
  const el=await frame.frameElement();
  let b=await el.boundingBox();
  const vp=(frame.page&&frame.page().viewportSize())||{width:1280,height:1000};
  if(b&&b.width>0&&b.height>0&&(b.y<0||b.y+b.height>vp.height||b.x<0||b.x+b.width>vp.width)){
   await el.scrollIntoViewIfNeeded({timeout:2000}).catch(()=>{});
   b=await el.boundingBox();
  }
  await el.dispose().catch(()=>{});
  return b;
 }catch{return null;}
}
// the frame element and every ancestor are rendered (hCaptcha parks full-viewport "enclave" frames with visibility:hidden)
export async function frameStyleVisible(frame){
 try{
  const el=await frame.frameElement();
  const v=await el.evaluate(e=>{for(let n=e;n&&n.nodeType===1;n=n.parentElement){const c=getComputedStyle(n);if(c.visibility==='hidden'||c.display==='none'||+c.opacity===0)return false;}return true;});
  await el.dispose().catch(()=>{});
  return v;
 }catch{return false;}
}
export async function visibleFrame(page,re,minW=30,minH=30){
 for(const f of framesMatching(page,re)){
  const b=await frameBox(f);
  // a reCAPTCHA challenge frame also has to be rendered (hidden full-size until it opens)
  if(b&&b.width>=minW&&b.height>=minH&&b.y>-1000&&b.x>-1000&&(!/\/bframe/.test(f.url())||await frameStyleVisible(f)))return {frame:f,box:b};
 }
 return null;
}
// element rect inside a frame -> page coordinates
export async function pageRect(page,frame,rect){
 if(frame===mainOf(page))return rect;
 const b=await frameBox(frame);
 return b?{x:b.x+rect.x,y:b.y+rect.y,width:rect.width,height:rect.height}:null;
}
// rects of every element matching sel inside a frame (frame-viewport coordinates)
export const domRects=(frame,sel,min=20)=>safeEval(frame,({sel,min})=>[...document.querySelectorAll(sel)]
 .map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})
 .filter(r=>r.width>=min&&r.height>=min),{sel,min},[]);
export const textOf=(frame,sel)=>safeEval(frame,sel=>{const e=document.querySelector(sel);return e?e.innerText.trim():'';},sel,'');
export async function anyFrame(page,fn){for(const f of scan(page))if(await safeEval(f,fn,undefined,false))return true;return false;}

// -- widget state -------------------------------------------------------------------------------
export const recapChecked=async page=>{
 for(const f of framesMatching(page,/recaptcha.*\/anchor/))if(await safeEval(f,()=>!!document.querySelector('#recaptcha-anchor[aria-checked="true"]'),undefined,false))return true;
 return false;
};
export const hcapToken=page=>anyFrame(page,()=>[...document.querySelectorAll('textarea[name*="h-captcha-response"], textarea[name*="hcaptcha"], input[name*="h-captcha-response"]')].some(e=>(e.value||'').length>10));
export const hcapChallenge=async page=>{
 for(const f of framesMatching(page,/hcaptcha/)){
  if(!(await safeEval(f,()=>!!document.querySelector('.challenge-container, .task-image, .challenge-view, .prompt-text, canvas'),undefined,false)))continue;
  if(/frame=(enclave|checkbox)/.test(f.url()))continue;
  const b=await frameBox(f);
  if(b&&b.width>250&&b.height>250&&b.y>-500&&(await frameStyleVisible(f)))return {frame:f,box:b};
 }
 return null;
};
// Turnstile token length in the host page; an expired token (they live 300 s) counts as none
export const tsToken=async page=>{
 let best=-1;
 for(const f of scan(page)){
  const n=await safeEval(f,()=>{
   let expired=false;try{expired=!!(window.turnstile&&typeof window.turnstile.isExpired==='function'&&window.turnstile.isExpired());}catch{}
   return expired?0:Math.max(-1,...[...document.querySelectorAll('[name="cf-turnstile-response"], input[name*="turnstile"]')].map(e=>(e.value||'').length));
  },undefined,-1);
  best=Math.max(best,n);
 }
 return best;
};
export const mtcapVerified=page=>anyFrame(page,()=>[...document.querySelectorAll('input[name="mtcaptcha-verifiedtoken"]')].some(e=>(e.value||'').length>10));

// hCaptcha's own verdict: an invisible widget's token goes straight into the site's callback (Lever
// submits the form and resets the widget), so "no token in the textarea" is not proof of a miss.
// Its /checkcaptcha reply says pass or fail; a pass counts as solved.
const HCAP_VERDICT=new WeakMap();
const HCAP_SITE_OPENED=new WeakMap();
export const siteOpened=page=>HCAP_SITE_OPENED.get(page)===page.url();
export const markOpened=page=>HCAP_SITE_OPENED.set(page,page.url());
export function watchHcapVerdict(page,{trace=()=>{}}={}){
 if(page.__captchaHcapWatch||typeof page.on!=='function')return;
 page.__captchaHcapWatch=true;
 page.on('response',async resp=>{
  try{
   if(!/hcaptcha\.com\/checkcaptcha\//.test(resp.url()))return;
   const j=await resp.json().catch(()=>null);
   const pass=!!(j&&(j.pass===true||j.generated_pass_UUID));
   HCAP_VERDICT.set(page,{pass,at:Date.now(),url:page.url()});
   trace(pass?'hCaptcha server: pass':'hCaptcha server: rejected');
  }catch{}
 });
}
export const hcapPassedSince=(page,t0)=>{const v=HCAP_VERDICT.get(page);return !!(v&&v.pass&&v.at>=t0&&v.url===page.url());};
export const recordHcapVerdict=(page,pass)=>HCAP_VERDICT.set(page,{pass,at:Date.now(),url:page.url()}); // tests

// -- DOM signals, evaluated in every frame --------------------------------------------------------
export function domSignals(){
 const q=s=>document.querySelector(s);
 const vis=e=>{if(!e)return false;const r=e.getBoundingClientRect();return r.width>8&&r.height>8;};
 const body=(document.body?document.body.innerText:'').slice(0,3000);
 const title=document.title||'';
 const scripts=[...document.scripts].map(s=>s.src).join(' ');
 const html=(document.documentElement.outerHTML||'').slice(0,60000);
 // the image's own path / id / class / alt, never its host name; no SVG logos
 const capSig=e=>{let p='';try{p=e.src&&!/^data:/.test(e.src)?new URL(e.src).pathname:'';}catch{}
  return (p+' '+e.id+' '+(typeof e.className==='string'?e.className:'')+' '+(e.alt||'')+' '+(e.getAttribute('name')||'')).toLowerCase();};
 const isCapImg=e=>{const s=capSig(e),r=e.getBoundingClientRect();
  return /captcha|securimage|kcaptcha|verif\w*[-_ ]?code|security[-_ ]?code/.test(s)&&!/recaptcha|hcaptcha|\.svg\b/.test(s)&&!/\.svg(\?|$)/.test(e.src||'')&&r.width>=50&&r.height>=18&&r.height<=220;};
 const capImg=[...document.querySelectorAll('img, canvas')].some(isCapImg);
 const capInput=[...document.querySelectorAll('input')].some(i=>/captcha|security.?code|verification.?code|characters|code.*(image|shown|above)/i
  .test((i.name||'')+' '+(i.id||'')+' '+(i.placeholder||'')+' '+(i.getAttribute('aria-label')||''))&&vis(i)&&!i.value&&!/recaptcha|hcaptcha|turnstile/i.test(i.name||''));
 const attr=(sel,name)=>{const e=q(sel);return e?(e.getAttribute(name)||''):'';};
 const val=sel=>{const e=q(sel);return e?(e.value||''):'';};
 return {
  cfInterstitial:/^just a moment/i.test(title)||!!q('#challenge-running, #challenge-stage, #challenge-form, #cf-challenge-running')||(/cdn-cgi\/challenge-platform/.test(scripts)&&/verify you are human|checking (if the site connection is secure|your browser)/i.test(body)),
  turnstileHost:vis(q('.cf-turnstile, [data-sitekey][class*=turnstile], #cf-turnstile')),
  pxHold:vis(q('#px-captcha')),
  // solved widgets stay on screen (Friendly Captcha, ALTCHA): count them only while unsolved
  friendly:vis(q('.frc-captcha'))&&!q('.frc-success')&&!val('input[name="frc-captcha-solution"], input[name="frc-captcha-response"]').replace(/^\..*/,''),
  altcha:vis(q('altcha-widget, .altcha'))&&!/verified/i.test(attr('altcha-widget, .altcha','data-state'))&&!val('input[name="altcha"]'),
  mcaptcha:!!q('iframe[src*="mcaptcha"]')&&!val('input[name="mcaptcha__token"]'),
  mtcaptcha:!!q('.mtcaptcha, iframe[src*="mtcaptcha"]')&&!val('input[name="mtcaptcha-verifiedtoken"]').length,
  geetest:vis(q('.geetest_box, .geetest_holder, .geetest_panel, [class^="geetest_"], .geetest_radar_tip'))&&!q('[class*="geetest_success"], .geetest_lock_success, .geetest_radar_success'),
  aws:!!q('awswaf-captcha, #captcha-container [class*=amzn], #aws-waf-token')||/captcha\.awswaf\.com|token\.awswaf\.com/.test(scripts),
  awsVisible:vis(q('awswaf-captcha, #captcha-container')),
  recaptchaV3:/recaptcha\/(api|enterprise)\.js\?[^ ]*render=(?!explicit)/.test(scripts)||!!q('.grecaptcha-badge'),
  textImage:capImg&&capInput,
  math:capInput&&/\b\d{1,2}\s*[+\-x×*]\s*\d{1,2}\s*=?\s*\??/.test(body)&&/captcha|security|verif|human|spam/i.test(body),
  slider:vis(q('[class*="slider"][class*="captcha"], [id*="slider"][id*="captcha"], .sliderContainer, #captcha__puzzle, [class*="puzzle"][class*="slide"], .slider-captcha')),
  akamai:/access denied/i.test(title+' '+body.slice(0,400))&&/reference\s*#\s*\d+\.|errors\.edgesuite\.net|you don.?t have permission to access/i.test(body),
  kasada:/ips\.js|KPSDK/i.test(scripts+html.slice(0,20000))&&body.length<400,
  incapsula:/_Incapsula_Resource|incident id/i.test(html)&&/request unsuccessful|incapsula/i.test(body+html.slice(0,5000)),
  ddBlock:/you have been blocked|blocked by datadome/i.test(body)||(/captcha-delivery\.com/.test(html)&&/access is temporarily restricted/i.test(body)),
  forbidden:/^\s*(403 forbidden|forbidden|request blocked)\b/i.test(body.slice(0,100)),
 };
}

// Turn per-frame observations into the vendor list. Pure, so tests can feed it directly.
export function classify({frames,signals,mainFrame}){
 const out=[];
 const add=(vendor,kind,solvable,note)=>{if(!out.some(v=>v.vendor===vendor&&v.kind===kind))out.push({vendor,kind,solvable,...(note?{note}:{})});};
 for(const f of frames){
  const u=f.url;
  if(/captcha-delivery\.com|arkoselabs\.com|funcaptcha\.com|geetest\.com|awswaf\.com/.test(u)&&!f.showsPuzzle)continue;
  if(/google\.com\/recaptcha|recaptcha\.net\/recaptcha/.test(u)){
   if(/\/bframe/.test(u)){if(f.shown&&f.rendered)add('recaptcha','challenge',true);}
   else if(/size=invisible/.test(u))add('recaptcha','invisible',false,'score-based (v3 / invisible / Enterprise): there is nothing to click');
   else if(/\/anchor/.test(u))add('recaptcha','checkbox',true);
  }
  if(/hcaptcha\.com/.test(u)&&!/frame=enclave/.test(u)){
   if(/frame=checkbox-invisible/.test(u))add('hcaptcha','invisible',true,'invisible widget: opens on the form submit');
   else add('hcaptcha',/frame=challenge|hcaptcha-challenge|\/challenge/.test(u)&&f.shown&&f.rendered?'challenge':'checkbox',true);
  }
  if(/challenges\.cloudflare\.com/.test(u))add('turnstile','widget',true);
  if(/captcha-delivery\.com/.test(u))add('datadome','slider',true);
  if(/arkoselabs\.com|funcaptcha\.com/.test(u))add('arkose','game',true,'best effort (vision, multi-round)');
  if(/geetest\.com/.test(u))add('geetest','challenge',true);
  if(/awswaf\.com/.test(u))add('aws-waf','challenge',true);
  if(/mcaptcha/.test(u))add('mcaptcha','proof-of-work',true);
  if(/mtcaptcha\.com/.test(u)&&!f.mtVerified)add('mtcaptcha','text-image',true);
 }
 for(const {s,main} of signals){
  if(!s)continue;
  if(s.akamai)add('akamai','wall',false,'edge block (Access Denied / Reference #): never solved');
  if(s.kasada)add('kasada','wall',false,'edge block: never solved');
  if(s.incapsula)add('incapsula','wall',false,'edge block: never solved');
  if(s.ddBlock)add('datadome','wall',false,'hard block: never solved');
  if(s.forbidden&&main)add('http-403','wall',false,'the server refused the request');
  if(s.cfInterstitial)add('cloudflare','interstitial',true,'managed challenge: usually passes on its own');
  if(s.turnstileHost&&!out.some(v=>v.vendor==='turnstile'))add('turnstile','widget',true,'widget host found (iframe in a closed shadow root)');
  if(s.pxHold)add('perimeterx','press-and-hold',true);
  if(s.friendly)add('friendly-captcha','proof-of-work',true);
  if(s.altcha)add('altcha','proof-of-work',true);
  if(s.mcaptcha)add('mcaptcha','proof-of-work',true);
  if(s.mtcaptcha)add('mtcaptcha','text-image',true);
  if(s.geetest)add('geetest','challenge',true);
  if(s.awsVisible)add('aws-waf','challenge',true);
  if(s.math)add('math','arithmetic',false,'arithmetic questions are never answered automatically (trap-question rule)');
  else if(s.textImage)add('text-image','ocr',true);
  if(s.slider&&!out.some(v=>/slider/.test(v.kind)))add('slider','slider',true);
  if(s.recaptchaV3&&!out.some(v=>v.vendor==='recaptcha'))add('recaptcha','invisible',false,'score-based (v3 / Enterprise): nothing to click');
 }
 void mainFrame;
 return out;
}

export async function identify(page){
 const frames=[];
 for(const f of page.frames()){
  let u='';try{u=f.url();}catch{continue;}
  const entry={url:u};
  if(/captcha-delivery\.com|arkoselabs\.com|funcaptcha\.com|geetest\.com|awswaf\.com/.test(u))
   entry.showsPuzzle=await safeEval(f,()=>!!document.querySelector('canvas, .sliderContainer, .geetest_box, [class*="slider"], [class*="captcha"] img, button, img'),undefined,false);
  if(/google\.com\/recaptcha|recaptcha\.net\/recaptcha|hcaptcha\.com/.test(u)&&!/frame=enclave|size=invisible|frame=checkbox-invisible/.test(u)){
   const b=await frameBox(f);
   // a challenge frame counts only when it is OPEN on screen: reCAPTCHA/hCaptcha preload a hidden challenge frame on every page
   entry.shown=!!(b&&b.width>250&&b.height>250&&b.y>-200&&b.x>-200);
   entry.rendered=entry.shown?await frameStyleVisible(f):false;
  }
  if(/mtcaptcha\.com/.test(u))entry.mtVerified=await mtcapVerified(page);
  frames.push(entry);
 }
 const signals=[];
 for(const f of scan(page))signals.push({s:await safeEval(f,domSignals,undefined,null),main:f===mainOf(page)});
 const out=classify({frames,signals});
 // hCaptcha with no on-screen checkbox and no open challenge = an INVISIBLE widget (iCIMS sign-in, Lever): it opens on
 // the form's submit; it must not be fired early (that would submit an unfilled form)
 if(out.some(v=>v.vendor==='hcaptcha')){
  let onScreen=false;
  for(const f of framesMatching(page,/hcaptcha/)){
   if(/frame=(enclave|checkbox-invisible)/.test(f.url()))continue;
   const b=await frameBox(f);if(b&&b.width>50&&b.height>30&&b.y>-200&&b.x>-200&&(await frameStyleVisible(f))){onScreen=true;break;}
  }
  if(!onScreen&&!(await hcapChallenge(page))){
   for(let i=out.length-1;i>=0;i--)if(out[i].vendor==='hcaptcha')out.splice(i,1);
   out.push({vendor:'hcaptcha',kind:'invisible',solvable:true,note:'invisible widget: opens on the form submit'});
  }
 }
 // a widget that already holds its token stays on the page: report it as solved, not as work to do
 const done=async vendor=>vendor==='recaptcha'?recapChecked(page)
  :vendor==='hcaptcha'?((await hcapToken(page))||(hcapPassedSince(page,Date.now()-120000)&&!(await hcapChallenge(page))))
  :vendor==='turnstile'?(await tsToken(page))>10:false;
 const final=[];
 for(const v of out){
  if(['recaptcha','hcaptcha','turnstile'].includes(v.vendor)&&!(v.vendor==='recaptcha'&&v.kind==='invisible')&&await done(v.vendor)){
   if(!final.some(x=>x.vendor===v.vendor&&x.kind==='solved'))final.push({vendor:v.vendor,kind:'solved',solvable:false});
  }else final.push(v);
 }
 return final;
}
export const isWall=vendors=>vendors.some(v=>v.kind==='wall');
export const vendorText=vendors=>vendors.map(v=>v.vendor+(v.kind?'/'+v.kind:'')).join(', ')||'unidentified';
