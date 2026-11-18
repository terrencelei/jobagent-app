// Humanlike pointer input (2026-11-01). hCaptcha scores the motion before a click: Playwright's
// page.click jumps the pointer straight onto the target in one event, which no person produces.
// humanMove travels a curved, eased path with small jitter; humanClick moves, pauses, and presses.
let last=new WeakMap();

const ease=t=>t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2;

// Points along a quadratic Bezier from (x0,y0) to (x1,y1), bowed to one side, eased in and out.
export function pathPoints(x0,y0,x1,y1,{steps,random=Math.random}={}){
 const dist=Math.hypot(x1-x0,y1-y0);
 const n=steps??Math.max(12,Math.min(60,Math.round(dist/12)));
 const bow=(random()-.5)*Math.min(160,dist*.35);
 const mx=(x0+x1)/2-(y1-y0)/(dist||1)*bow,my=(y0+y1)/2+(x1-x0)/(dist||1)*bow;
 const out=[];
 for(let i=1;i<=n;i++){
  const t=ease(i/n),u=1-t;
  const jitter=i<n?(random()-.5)*1.6:0;
  out.push([u*u*x0+2*u*t*mx+t*t*x1+jitter,u*u*y0+2*u*t*my+t*t*y1+jitter]);
 }
 return out;
}

// A real mouse reports several samples per screen frame, which Chrome bundles into each pointermove
// (getCoalescedEvents().length > 1); one CDP move per frame never does (tools/input-probe.mjs, lesson 422:
// his sample 17% of pointermoves coalesced, the worker's 0). So moves go out about once per frame, and about one
// frame in five carries two samples sent together, which Chrome coalesces.
export async function humanMove(page,x,y,{random=Math.random}={}){
 const vp=page.viewportSize?.()??{width:1280,height:900};
 let [px,py]=last.get(page)??[vp.width*(.3+random()*.4),vp.height*(.2+random()*.3)];
 for(const [nx,ny] of pathPoints(px,py,x,y,{random})){
  // His sample: no two moves under 4 ms apart, 17% of pointermoves carrying 2 samples (mean 1.2).
  const subs=random()<.2?2:1,moves=[];
  // Sent without waiting for each acknowledgement, so they queue inside Chrome and are coalesced per frame.
  for(let i=1;i<=subs;i++)moves.push(page.mouse.move(px+(nx-px)*i/subs,py+(ny-py)*i/subs));
  await Promise.all(moves);
  px=nx;py=ny;
  // About one screen frame between bursts, like his mousemoves (median 15.7 ms apart).
  await page.waitForTimeout(12+random()*8);
 }
 last.set(page,[x,y]);
}

// One key the way a finger presses it: held 60-150 ms (his median 91 ms; Playwright's type releases in ~2 ms).
export async function humanKey(page,key,{random=Math.random}={}){
 await page.keyboard.down(key);await page.waitForTimeout(60+random()*90);await page.keyboard.up(key);
}
export async function humanType(page,text,{random=Math.random}={}){
 for(const ch of text){
  if(ch.length===1&&!/[\x20-\x7e]/.test(ch))await page.keyboard.insertText(ch);  // non-ASCII: no physical key
  else await humanKey(page,ch===' '?'Space':ch,{random});
  await page.waitForTimeout(25+random()*120);
 }
}

// Click a locator the way a person does: scroll it into view, travel to a point inside it (not the exact
// centre), pause, press and release. Falls back to locator.click when the element has no box.
export async function humanClick(page,locator,{random=Math.random}={}){
 await locator.scrollIntoViewIfNeeded().catch(()=>{});
 const box=await locator.boundingBox().catch(()=>null);
 if(!box)return locator.click();
 const x=box.x+box.width*(.35+random()*.3),y=box.y+box.height*(.35+random()*.3);
 await humanMove(page,x,y,{random});
 await page.waitForTimeout(80+random()*220);
 await page.mouse.down();await page.waitForTimeout(50+random()*90);await page.mouse.up();
}

// A few idle movements across the page while it "reads" the form before Submit.
export async function humanBrowse(page,{moves=3,random=Math.random}={}){
 const vp=page.viewportSize?.()??{width:1280,height:900};
 for(let i=0;i<moves;i++){
  await humanMove(page,vp.width*(.15+random()*.7),vp.height*(.15+random()*.7),{random});
  await page.waitForTimeout(250+random()*700);
 }
}

// Type into text fields key by key (2026-11-01). hCaptcha's invisible mode scores the keyboard and pointer
// activity on the host page; a form whose every field appears at once, with no keydown at all, scored badly
// enough that Lever answered "There was an error verifying your application" even after he solved the
// challenge himself (Zoox 10953). Installed once per worker for real-Chrome runs: each Locator.fill of a
// non-empty string into a text-like input or textarea becomes a humanlike click, a clear, and typed keys.
const TYPED=/^(text|email|tel|url|search|number|textarea)$/;
export function installHumanTyping(LocatorClass,{random=Math.random,longText=400}={}){
 const proto=LocatorClass.prototype;
 if(proto.__humanTyping)return;
 const fill=proto.fill;
 proto.fill=async function(value,options){
  if(typeof value!=='string'||!value)return fill.call(this,value,options);
  const kind=await this.evaluate(el=>el.tagName==='TEXTAREA'?'textarea':el.tagName==='INPUT'?(el.type||'text').toLowerCase():'').catch(()=>'');
  if(!TYPED.test(kind))return fill.call(this,value,options);
  const page=this.page();
  await humanClick(page,this,{random}).catch(()=>{});
  await fill.call(this,'',options);
  await this.focus();
  // keyboard.type goes to whatever has focus, so the value is checked afterwards; a field the page rewrote
  // while typing (Lever's resume parser, a mask) gets the exact value with a plain fill.
  if(value.length>longText)await this.pressSequentially(value,{delay:12,timeout:Math.max(options?.timeout??0,30000+value.length*40)});
  else await humanType(page,value,{random});
  if(await this.inputValue().catch(()=>null)!==value)await fill.call(this,value,options);
 };
 proto.__humanTyping=true;
}

// Trusted file and dropdown input (2026-11-02, lesson 423). tools/input-probe.mjs showed what a page sees: Playwright's
// setInputFiles over a connected Chrome copies the file in by script and fires input/change with isTrusted:false,
// and selectOption does the same for a <select>. A person's drag, file pick or dropdown choice fires them trusted.
// Chrome's own DOM.setFileInputFiles fires trusted events, and typing the start of an option's text into a focused,
// closed <select> selects it with trusted events. Installed with installHumanTyping for real-Chrome runs; anything
// it cannot do (a frame of another process, an ambiguous option name) falls back to Playwright's method.
let marks=0,lastSelectAt=0;
export async function trustedSetFiles(locator,files,{session}={}){
 const paths=(Array.isArray(files)?files:[files]);
 if(!paths.length||paths.some(p=>typeof p!=='string'))return false;
 const page=locator.page();
 if(locator._frame&&locator._frame!==page.mainFrame())return false;
 const mark=`ja${Date.now()}${++marks}`;
 await locator.evaluate((el,m)=>el.setAttribute('data-ja-file',m),mark);
 const cdp=session??await page.context().newCDPSession(page);
 try{
  const {result}=await cdp.send('Runtime.evaluate',{expression:`document.querySelector('[data-ja-file="${mark}"]')`});
  if(!result?.objectId)return false;
  const {resolve}=await import('node:path');
  await cdp.send('DOM.setFileInputFiles',{files:paths.map(p=>resolve(p)),objectId:result.objectId});
  return true;
 }finally{
  await locator.evaluate(el=>el.removeAttribute('data-ja-file')).catch(()=>{});
  if(!session)await cdp.detach().catch(()=>{});
 }
}

export async function trustedSelect(locator,value,{random=Math.random}={}){
 const want=typeof value==='string'?{any:value}:value&&!Array.isArray(value)?value:null;
 if(!want)return null;
 const target=await locator.evaluate((el,w)=>{
  if(el.tagName!=='SELECT'||el.multiple)return null;
  const o=[...el.options].find(o=>w.any!=null?(o.value===w.any||o.label.trim()===w.any.trim()):w.label!=null?o.label.trim()===String(w.label).trim():w.value!=null?o.value===w.value:false);
  if(!o)return null;
  // Chrome's type-to-select matches the start of the option text; use the shortest prefix that is unique.
  const labels=[...el.options].map(x=>x.label.trim().toLowerCase()),mine=o.label.trim().toLowerCase();
  let n=1;while(n<mine.length&&labels.filter(l=>l.startsWith(mine.slice(0,n))).length>1)n++;
  const unique=labels.filter(l=>l.startsWith(mine.slice(0,n))).length===1;
  // No unique prefix ("Yes" beside "Yes, with sponsorship"): the whole text, which matches it first.
  return {value:o.value,prefix:unique?o.label.trim().slice(0,Math.max(n,Math.min(mine.length,4))):o.label.trim().slice(0,40)};
 },want).catch(()=>null);
 if(!target?.prefix)return null;
 const page=locator.page();
 // Chrome joins keys typed within ~1 s into one type-to-select search, so consecutive choices wait it out.
 const since=Date.now()-lastSelectAt;if(since<1200)await page.waitForTimeout(1200-since);
 await locator.scrollIntoViewIfNeeded().catch(()=>{});await locator.focus();
 for(const ch of target.prefix){
  if(ch===' '){await page.keyboard.press('Space');continue;}
  await page.keyboard.down(ch);await page.waitForTimeout(30+random()*40);await page.keyboard.up(ch);await page.waitForTimeout(40+random()*60);
 }
 lastSelectAt=Date.now();await page.waitForTimeout(150);
 return (await locator.inputValue().catch(()=>null))===target.value?[target.value]:null;
}

export async function filesAlreadySet(locator,files){
 const names=(Array.isArray(files)?files:[files]).map(f=>typeof f==='string'?f.split(/[\\/]/).pop():f?.name).filter(Boolean);
 if(!names.length)return false;
 const held=await locator.evaluate(el=>[...(el.files||[])].map(f=>f.name),undefined,{timeout:3000}).catch(()=>[]);
 return names.length===held.length&&names.every(n=>held.includes(n));
}

export function installTrustedInput(LocatorClass,{random=Math.random}={}){
 const proto=LocatorClass.prototype;
 if(proto.__trustedInput)return;
 const setFiles=proto.setInputFiles,select=proto.selectOption;
 proto.setInputFiles=async function(files,options){
  if(await trustedSetFiles(this,files).catch(()=>false))return;
  try{return await setFiles.call(this,files,options);}
  catch(error){
   // Rivian iCIMS 12058 (lesson 454): the file landed (the page showed it) but the input's change handler started the
   // site's own upload, and Playwright timed out waiting on it. A timeout with the requested files already in the input
   // is a completed set; the caller still verifies the attachment.
   if(error?.name==='TimeoutError'&&await filesAlreadySet(this,files))return;
   throw error;
  }
 };
 proto.selectOption=async function(values,options){
  const done=await trustedSelect(this,values,{random}).catch(()=>null);
  return done??select.call(this,values,options);
 };
 proto.__trustedInput=true;
}
