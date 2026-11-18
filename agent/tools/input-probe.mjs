#!/usr/bin/env node
// What a page sees of the input it receives (2026-11-02, lesson 422). hCaptcha passed his own retries invisibly
// and challenged the worker's, so this records every property a page script can read from mouse, pointer and
// keyboard events, and compares a sample he makes by hand with the worker's synthetic input in the same Chrome.
//
//   node tools/input-probe.mjs serve                 # serves the page on 127.0.0.1:8799, logs to private/input-probe/
//   node tools/input-probe.mjs open <label>          # opens it in his finish-yourself Chrome WITHOUT attaching
//   node tools/input-probe.mjs agent                 # the worker's input (human-input.mjs over CDP) on the page
//   node tools/input-probe.mjs compare human agent   # side-by-side summary
import {createServer} from 'node:http';
import {mkdir,appendFile,readFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
const DIR=join(ROOT,'private/input-probe');const PORT=8799;
const PAGE=`<!doctype html><meta charset=utf-8><title>Input probe</title>
<style>body{font:16px -apple-system;margin:40px}#pad{width:600px;height:260px;border:2px dashed #888;margin:16px 0}button{font-size:18px;padding:10px 24px}input{font-size:18px;width:400px}</style>
<h2>Input probe</h2><p>Move the mouse around the box for a few seconds, click the button, then click the text field and type <b>hello world</b>. Press Done.</p>
<div id=pad></div><button id=b>Click me</button><p><input id=t placeholder="type hello world"></p>
<p>Then attach your resume here the way you do on Lever (drag it onto the button, or click it and pick the file):</p>
<div style="position:relative;display:inline-block"><span id=attach style="display:inline-block;padding:10px 24px;border:1px solid #aaa;background:#eee">ATTACH RESUME/CV</span>
<input type=file name=resume id=resume style="position:absolute;inset:0;opacity:0;cursor:pointer"></div> <span id=fname></span>
<p><button id=done>Done</button><p id=s></p>
<script>
const label=new URLSearchParams(location.search).get('label')||'unknown',log=[];
const env={ua:navigator.userAgent,webdriver:navigator.webdriver,hasFocus:document.hasFocus(),vis:document.visibilityState,
 screenX,screenY,outer:[outerWidth,outerHeight],inner:[innerWidth,innerHeight],dpr:devicePixelRatio,activation:navigator.userActivation?.hasBeenActive};
const P=['type','isTrusted','timeStamp','clientX','clientY','screenX','screenY','movementX','movementY','offsetX','offsetY','button','buttons','detail',
 'pointerType','pressure','width','height','tiltX','tiltY','twist','isPrimary','pointerId','key','code','keyCode','location','repeat','which'];
const rec=e=>{const o={};for(const k of P)if(k in e)o[k]=e[k];if(e.getCoalescedEvents)o.coalesced=e.getCoalescedEvents().length;
 o.target=e.target.id||e.target.tagName;o.focus=document.hasFocus();o.activation=navigator.userActivation?.isActive;log.push(o);};
// What a page can see when a file arrives (lesson 423): drag-and-drop data, chooser focus changes, the change event, the File.
const fileLog=[];const fileRec=e=>{const dt=e.dataTransfer;fileLog.push({type:e.type,isTrusted:e.isTrusted,t:e.timeStamp,target:e.target.id||e.target.tagName,
 dt:dt?{types:[...dt.types],effectAllowed:dt.effectAllowed,dropEffect:dt.dropEffect,items:[...dt.items].map(i=>i.kind+':'+i.type),files:dt.files.length}:undefined,
 activation:navigator.userActivation?.isActive,focus:document.hasFocus(),
 files:e.target.files?[...e.target.files].map(f=>({name:f.name,size:f.size,type:f.type,lastModified:f.lastModified,age_s:Math.round((Date.now()-f.lastModified)/1000),rel:f.webkitRelativePath})):undefined});};
for(const t of ['dragenter','dragover','dragleave','drop','change','input','cancel'])addEventListener(t,fileRec,{capture:true});
for(const t of ['focus','blur'])window.addEventListener(t,e=>{if(e.target===window)fileLog.push({type:'window-'+t,t:e.timeStamp,isTrusted:e.isTrusted});});
document.addEventListener('visibilitychange',()=>fileLog.push({type:'visibility-'+document.visibilityState,t:performance.now()}));
resume.addEventListener('change',()=>fname.textContent=resume.files[0]?.name||'');
for(const t of ['pointerover','pointerenter','pointermove','pointerdown','pointerup','mouseover','mousemove','mousedown','mouseup','click',
 'keydown','keypress','keyup','input','focus','blur','beforeinput','wheel','touchstart'])addEventListener(t,rec,{capture:true,passive:true});
done.onclick=()=>{fetch('/log?label='+label,{method:'POST',body:JSON.stringify({fileLog,env,envEnd:{hasFocus:document.hasFocus(),activation:navigator.userActivation?.hasBeenActive},log})}).then(()=>s.textContent='Sent '+log.length+' events. Thank you.');};
</script>`;

const [cmd,...args]=process.argv.slice(2);
if(cmd==='serve'){
 await mkdir(DIR,{recursive:true,mode:0o700});
 createServer(async(req,res)=>{
  const u=new URL(req.url,'http://x');
  if(req.method==='POST'&&u.pathname==='/log'){let b='';for await(const c of req)b+=c;const label=(u.searchParams.get('label')||'unknown').replace(/[^a-z0-9_-]/gi,'');
   await appendFile(join(DIR,label+'.json'),b+'\n');res.end('ok');console.log('logged',label);return;}
  res.writeHead(200,{'content-type':'text/html'});res.end(PAGE);
 }).listen(PORT,'127.0.0.1',()=>console.log('input probe on',PORT));
}else if(cmd==='open'){
 const ep=(await readFile(join(ROOT,'private/human-chrome/jobagent-endpoint'),'utf8')).trim();
 // /json/new is plain HTTP: Chrome opens the tab, nothing attaches to it.
 await fetch(`${ep}/json/new?http://127.0.0.1:${PORT}/?label=${args[0]||'human'}`,{method:'PUT'});console.log('opened');
}else if(cmd==='agent'){
 const {chromium}=await import('playwright');const {humanMove,humanClick,humanType}=await import('../src/human-input.mjs');
 const ep=(await readFile(join(ROOT,'private/human-chrome/jobagent-endpoint'),'utf8')).trim();
 const b=await chromium.connectOverCDP(ep);const ctx=b.contexts()[0];const page=await ctx.newPage();
 await page.goto(`http://127.0.0.1:${PORT}/?label=${args[0]||'agent'}`);
 const pad=await page.locator('#pad').boundingBox();
 for(let i=0;i<6;i++)await humanMove(page,pad.x+40+Math.random()*(pad.width-80),pad.y+30+Math.random()*(pad.height-60));
 await humanClick(page,page.locator('#b'));await humanClick(page,page.locator('#t'));
 await humanType(page,'hello world');
 if(process.env.PROBE_RESUME)await page.locator('#resume').setInputFiles(process.env.PROBE_RESUME);await page.waitForTimeout(800);
 await humanClick(page,page.locator('#done'));await page.waitForTimeout(1500);await page.close();await b.close();console.log('agent sample done');
}else if(cmd==='files'){
 for(const l of args){const d=JSON.parse((await readFile(join(DIR,l+'.json'),'utf8')).trim().split('\n').at(-1));
  console.log('==',l);for(const e of d.fileLog||[])console.log(JSON.stringify(e));}
}else if(cmd==='compare'){
 const load=async l=>JSON.parse((await readFile(join(DIR,l+'.json'),'utf8')).trim().split('\n').at(-1));
 const sum=d=>{const by=t=>d.log.filter(e=>e.type===t);const mm=by('mousemove'),pm=by('pointermove'),pd=by('pointerdown'),kd=by('keydown'),ku=by('keyup');
  const gaps=mm.slice(1).map((e,i)=>e.timeStamp-mm[i].timeStamp);
  const hold=kd.map(k=>{const u=ku.find(x=>x.code===k.code&&x.timeStamp>k.timeStamp);return u?u.timeStamp-k.timeStamp:null;}).filter(x=>x!=null);
  const med=a=>a.length?a.slice().sort((x,y)=>x-y)[a.length>>1]:null;
  return {env:d.env,events:d.log.length,order_first_click:d.log.filter(e=>e.target==='b').slice(0,12).map(e=>e.type).join(' > '),
   mousemoves:mm.length,movementNonZero:mm.filter(e=>e.movementX||e.movementY).length,screenMinusClient:[...new Set(mm.slice(0,50).map(e=>`${e.screenX-e.clientX},${e.screenY-e.clientY}`))].slice(0,4),
   coalescedOver1:pm.filter(e=>e.coalesced>1).length,moveGapMedianMs:med(gaps),pointerdown:pd.map(e=>({pressure:e.pressure,width:e.width,height:e.height,pointerId:e.pointerId,buttons:e.buttons,trusted:e.isTrusted}))[0],
   keyHoldMedianMs:med(hold),keydownSample:kd.slice(0,2).map(e=>({key:e.key,code:e.code,keyCode:e.keyCode,which:e.which,trusted:e.isTrusted})),
   keypress:by('keypress').length,beforeinput:by('beforeinput').length,trustedAll:d.log.every(e=>e.isTrusted)};};
 for(const l of args){console.log('==',l);console.log(JSON.stringify(sum(await load(l)),null,1));}
}
