// A Chrome window he submits from himself (2026-10-23). Lever's hCaptcha scores the browser, and a
// Playwright-launched Chrome carries automation flags and an attached debugger, so even after he
// solved the CAPTCHA and pressed Submit Lever answered "there was an issue" (Laminar 7092, Shield AI
// 12207). Here Chrome starts as a plain program with its own profile, the worker attaches over the
// DevTools port only to fill the form, and detaches before he touches it.
import {spawn,execFile} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdir,readFile,writeFile,rmdir,stat} from 'node:fs/promises';
import {ensureRelay} from './captcha-relay.mjs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
// The supplied package's extension (solver_ext) and the hCaptcha worker built for its hidden_captcha.js.
// Branded Chrome ignores --load-extension (since 137), so they are loaded over the DevTools port, which
// --enable-unsafe-extension-debugging allows. They post to the Relay panel (src/captcha-relay.mjs).
export const HUMAN_EXTENSIONS=[join(ROOT,'vendor/captcha-solver/solver_ext'),join(ROOT,'extensions/relay-hidden')];

export const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const chromeArgs=(profileDir,port)=>[`--user-data-dir=${profileDir}`,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1',
 '--enable-unsafe-extension-debugging','--no-first-run','--no-default-browser-check','--new-window','about:blank'];

// The hidden relay Chrome (the supplied package's "hidden Relay Chrome": a plain, non-automated Chrome
// whose extension worker answers hCaptcha). Same profile model as his hand-off window, but started
// hidden (`open -g -j`) and off-screen, with occluded-window throttling off so pages still render and
// the worker's screenshots are real. Allowed under his 2026-10-24 change to the headless rule.
export const RELAY_CHROME_APP='/Applications/Google Chrome.app';
export const hiddenWindowArgs=['--window-position=-12000,-12000','--window-size=1280,1000','--disable-backgrounding-occluded-windows',
 '--disable-renderer-backgrounding','--disable-background-timer-throttling'];
export const hiddenLaunch=(profileDir,port,app=RELAY_CHROME_APP)=>['open',['-n','-g','-j','-a',app,'--args',...chromeArgs(profileDir,port),...hiddenWindowArgs]];

// One DevTools call on the browser target.
async function browserCommand(endpoint,method,params,{fetchImpl=fetch,WebSocketImpl=globalThis.WebSocket,timeoutMs=8000}={}){
 const {webSocketDebuggerUrl}=await (await fetchImpl(`${endpoint}/json/version`)).json();
 const ws=new WebSocketImpl(webSocketDebuggerUrl);
 try{
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=()=>reject(new Error('DevTools socket failed'));});
  return await new Promise((resolve,reject)=>{
   const t=setTimeout(()=>reject(new Error(`${method} timed out`)),timeoutMs);
   ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id!==1)return;clearTimeout(t);m.error?reject(new Error(m.error.message)):resolve(m.result);};
   ws.send(JSON.stringify({id:1,method,params}));
  });
 }finally{ws.close();}
}

// macOS shows an app again when it opens a tab, so the relay Chrome is hidden again by its browser
// process (the one without --type=, found by its profile directory) through System Events.
const run=(cmd,args)=>new Promise(resolve=>execFile(cmd,args,{timeout:5000},(e,out)=>resolve(e?'':String(out))));
export async function relayChromePid(profileDir,{exec=run}={}){
 for(const line of (await exec('ps',['-axo','pid=,command='])).split('\n')){
  const m=line.match(/^\s*(\d+)\s+(.*)$/);
  if(m&&m[2].includes(`--user-data-dir=${profileDir}`)&&!m[2].includes('--type='))return Number(m[1]);
 }
 return null;
}
export async function hideChrome(profileDir,{exec=run}={}){
 const pid=await relayChromePid(profileDir,{exec});if(!pid)return false;
 await exec('osascript',['-e',`tell application "System Events" to set visible of (first process whose unix id is ${pid}) to false`]);
 return true;
}
// While a run uses the relay Chrome: re-hide it whenever it shows itself (a new tab, a dialog).
export function keepHidden(profileDir,{everyMs=1500,exec=run}={}){
 const check=`tell application "System Events" to get visible of (first process whose unix id is %PID%)`;
 let busy=false;
 const timer=setInterval(async()=>{
  if(busy)return;busy=true;
  try{const pid=await relayChromePid(profileDir,{exec});if(pid&&/true/.test(await exec('osascript',['-e',check.replace('%PID%',pid)])))await hideChrome(profileDir,{exec});}
  finally{busy=false;}
 },everyMs);
 timer.unref?.();
 return ()=>clearInterval(timer);
}

// Extensions.loadUnpacked on the browser target. A failure leaves the window as it was.
export async function loadExtensions(endpoint,paths=HUMAN_EXTENSIONS,{fetchImpl=fetch,WebSocketImpl=globalThis.WebSocket,timeoutMs=8000}={}){
 const {webSocketDebuggerUrl}=await (await fetchImpl(`${endpoint}/json/version`)).json();
 const ws=new WebSocketImpl(webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=()=>reject(new Error('DevTools socket failed'));});
 const results=[];let id=0;
 try{
  for(const path of paths){
   const n=++id;
   results.push(await new Promise(resolve=>{
    const t=setTimeout(()=>resolve({path,error:'timeout'}),timeoutMs);
    ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id!==n)return;clearTimeout(t);resolve(m.error?{path,error:m.error.message}:{path,id:m.result?.id});};
    ws.send(JSON.stringify({id:n,method:'Extensions.loadUnpacked',params:{path}}));
   }));
  }
 }finally{ws.close();}
 return results;
}

// A tab left by an earlier run can freeze (Ride Along's Ashby page, 2026-10-24) and then Playwright's
// connectOverCDP waits on it until its 30 s timeout, so no later posting could use the relay Chrome
// (Saronic 2784). Before attaching, each page that does not answer a trivial evaluate is closed.
// Responsive tabs, including another worker's, are left alone.
export async function closeHungTabs(endpoint,{keep='',fetchImpl=fetch,WebSocketImpl=globalThis.WebSocket,probeMs=3000}={}){
 const {webSocketDebuggerUrl}=await (await fetchImpl(`${endpoint}/json/version`)).json();
 const ws=new WebSocketImpl(webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=()=>reject(new Error('DevTools socket failed'));});
 let id=0;const pending=new Map();
 ws.onmessage=ev=>{const m=JSON.parse(ev.data);const done=pending.get(m.id);if(done){pending.delete(m.id);done(m);}};
 const send=(method,params={},sessionId,waitMs=probeMs)=>new Promise(resolve=>{const n=++id;pending.set(n,resolve);
  setTimeout(()=>{if(pending.delete(n))resolve({timeout:true});},waitMs);
  ws.send(JSON.stringify(sessionId?{id:n,method,params,sessionId}:{id:n,method,params}));});
 const closed=[];
 try{
  const {result}=await send('Target.getTargets');
  for(const t of result?.targetInfos??[]){
   if(t.type!=='page'||(keep&&t.url.endsWith('#'+keep)))continue;
   const attached=await send('Target.attachToTarget',{targetId:t.targetId,flatten:true});
   const sessionId=attached.result?.sessionId;
   let probe=sessionId?await send('Runtime.evaluate',{expression:'1'},sessionId):attached;
   // A busy tab of a concurrent run (Hermeus 13988, 2026-11-12: its tab vanished mid-form as another run attached)
   // can miss one short probe; only a tab that also misses a second, longer probe is treated as frozen.
   if(probe.timeout&&sessionId)probe=await send('Runtime.evaluate',{expression:'1'},sessionId,probeMs*3);
   if(probe.timeout){await send('Target.closeTarget',{targetId:t.targetId});closed.push(t.url);}
   else if(sessionId)await send('Target.detachFromTarget',{sessionId});
  }
 }finally{ws.close();}
 return closed;
}

export async function freePort(){
 return new Promise((resolve,reject)=>{const server=createServer();server.unref();server.on('error',reject);
  server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>resolve(port));});});
}

// Opens a fresh tab (about:blank#<marker>) in his finish-yourself Chrome, starting Chrome only when it is not already
// running: a second launch on the same profile would join the open Chrome and ignore the new DevTools port.
// Workers start at the same moment (four slots after a restart, 2026-10-24): without a lock two of them
// each launched Chrome on one profile, and the second waited on a port its Chrome never opened. The
// lock is a directory; one older than a minute is a crashed launcher's and is taken over.
export async function withLaunchLock(profileDir,fn,{timeoutMs=60000,staleMs=60000}={}){
 const lock=join(profileDir,'.jobagent-launch.lock');const until=Date.now()+timeoutMs;
 for(;;){
  try{await mkdir(lock);break;}
  catch(e){
   if(e.code!=='EEXIST')throw e;
   const age=await stat(lock).then(s=>Date.now()-s.mtimeMs).catch(()=>0);
   if(age>staleMs){await rmdir(lock).catch(()=>{});continue;}
   if(Date.now()>until)throw new Error('Another worker is still starting Chrome on this profile');
   await new Promise(r=>setTimeout(r,250));
  }
 }
 try{return await fn();}finally{await rmdir(lock).catch(()=>{});}
}

export async function launchHumanChrome(profileDir,{marker='jobagent',chrome=CHROME,port,spawnImpl=spawn,fetchImpl=fetch,timeoutMs=20000,extensions=HUMAN_EXTENSIONS,relay=ensureRelay,hidden=false,hide=hideChrome}={}){
 await mkdir(profileDir,{recursive:true,mode:0o700});
 return withLaunchLock(profileDir,async()=>{
 const alive=async endpoint=>{try{return (await fetchImpl(`${endpoint}/json/version`)).ok;}catch{return false;}};
 let endpoint=(await readFile(join(profileDir,'jobagent-endpoint'),'utf8').catch(()=>'')).trim();
 if(!endpoint||!await alive(endpoint)){
  port??=await freePort();
  // Detached and unreferenced: the window outlives the worker, which exits once the form is filled.
  const [cmd,args]=hidden?hiddenLaunch(profileDir,port):[chrome,chromeArgs(profileDir,port)];
  spawnImpl(cmd,args,{detached:true,stdio:'ignore'}).unref();
  endpoint=`http://127.0.0.1:${port}`;const until=Date.now()+timeoutMs;
  while(!await alive(endpoint)){if(Date.now()>until)throw new Error('Chrome did not open its window for you to finish the application');await new Promise(r=>setTimeout(r,300));}
  await writeFile(join(profileDir,'jobagent-endpoint'),endpoint).catch(()=>{});
  if(extensions?.length){await relay().catch(()=>{});await loadExtensions(endpoint,extensions,{fetchImpl}).catch(()=>{});}
 }
 // A tab Chrome creates (not Playwright) stays open when the worker disconnects. The hidden relay
 // Chrome opens it in the background, then is hidden again.
 if(hidden){
  // Its own window, so the form is that window's active tab. A background tab reads outerWidth/outerHeight
  // 0x0 (and outer = inner, screenY at the screen's bottom once Playwright attaches), which no tab a person
  // is looking at does; a page script sees it (tools/fingerprint-probe.mjs, 2026-11-01).
  await browserCommand(endpoint,'Target.createTarget',{url:`about:blank#${marker}`,newWindow:true,background:true},{fetchImpl}).catch(()=>fetchImpl(`${endpoint}/json/new?about:blank%23${encodeURIComponent(marker)}`,{method:'PUT'}));
  await closeHungTabs(endpoint,{keep:marker,fetchImpl}).catch(()=>[]);
  await hide(profileDir);
 }else await fetchImpl(`${endpoint}/json/new?about:blank%23${encodeURIComponent(marker)}`,{method:'PUT'});
 return endpoint;
 });
}

export const launchRelayChrome=(profileDir,options={})=>launchHumanChrome(profileDir,{...options,hidden:true});
