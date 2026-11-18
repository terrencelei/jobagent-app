// Loads the CAPTCHA package the user was given (vendor/captcha-solver, CommonJS, committed as supplied)
// into the ESM agent. The package is used as written: its solver is tier 0 in resolveChallengeFree, its
// detector widens captchaPending, and every application browser launches through its stealth.js with
// its solver_ext extension. The Relay panel those call is src/captcha-relay.mjs.
// Runtime links (venv, weights, ../pipeline) are made by tools/setup-captcha-models.sh.
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {ensureRelay} from './captcha-relay.mjs';

const require=createRequire(import.meta.url);
export const VENDOR_DIR=join(dirname(fileURLToPath(import.meta.url)),'..','vendor','captcha-solver');
export const SOLVER_EXTENSION=join(VENDOR_DIR,'solver_ext');
const load=name=>require(join(VENDOR_DIR,name));

let solver,detector,stealth;
export const vendorSolver=()=>solver??=load('captcha_solver.js');
export const vendorDetect=()=>detector??=load('captcha_detect.js');
export const vendorStealth=()=>stealth??=load('stealth.js');

// Same result shape as the agent's other tiers: {solved,type,how,wall,declined,policy,vendorText,error}.
export async function solveWithVendor(page,{company='',role='',url='',log=()=>{},maxAttempts=3}={}){
 const s=vendorSolver();
 await ensureRelay().catch(()=>{});   // the package's panel fallbacks (audio, slider, vlm_grid) post to it
 s.setContext({company:company||null,role:role||null,url:url||page.url(),via:'application-agent'});
 const r=await s.solveIfPresent(page,maxAttempts);
 if(r.type&&r.type!=='none')await log(`Package CAPTCHA solver (${r.vendorText||r.type}): ${r.solved?'solved':'not solved'}${r.how?` — ${r.how}`:''}`);
 return r;
}

// Playwright's chromium with the package's stealth launch (real Chrome binary, corrected UA and client
// hints), its STEALTH_ARGS, and its solver_ext in every browser; the Relay panel solver_ext posts to is
// started with the browser. Chrome runs extensions only in a persistent profile, so persistent launches
// load solver_ext as an extension (stealth.js picks the binary that can), and contexts made by launch()
// get the same solver.js in every frame as an init script (it uses no chrome.* API). Falls back to plain
// Playwright if the package cannot load. CAPTCHA_EXTENSION=0 leaves solver_ext out.
const extensionOn=(env=process.env)=>env.CAPTCHA_EXTENSION!=='0';
export function launchOptions(o={},{stealthArgs=[],extension=SOLVER_EXTENSION}={}){
 const args=[...new Set([...stealthArgs,...(o.args||[]),...(extension?[`--load-extension=${extension}`,`--disable-extensions-except=${extension}`]:[])])];
 const ignore=o.ignoreDefaultArgs===true?true:[...new Set([...(Array.isArray(o.ignoreDefaultArgs)?o.ignoreDefaultArgs:[]),...(extension?['--disable-extensions']:[])])];
 return {...o,args,...(ignore===true||ignore.length?{ignoreDefaultArgs:ignore}:{})};
}
// solver.js waits for document_idle as a content script; the init script runs it at DOMContentLoaded.
export const solverInitScript=(src=readFileSync(join(SOLVER_EXTENSION,'solver.js'),'utf8'))=>
 `(()=>{const run=()=>{${src}
};if(document.readyState==='loading')addEventListener('DOMContentLoaded',run,{once:true});else run();})();`;
export async function applicationChromium(){
 const {chromium:plain}=await import('playwright');
 let st;try{st=vendorStealth();}catch{return plain;}
 const stealthArgs=st.STEALTH_ARGS||[];
 return new Proxy(st.chromium,{get(target,prop){
  if(prop==='launch')return async(o={})=>{
   const browser=await target.launch(launchOptions(o,{stealthArgs,extension:null}));
   if(!extensionOn())return browser;
   ensureRelay().catch(()=>{});
   const script=solverInitScript();const newContext=browser.newContext.bind(browser);
   browser.newContext=async(opts={})=>{const ctx=await newContext(opts);await ctx.addInitScript(script);return ctx;};
   return browser;
  };
  if(prop==='launchPersistentContext')return (dir,o={})=>{
   const ext=extensionOn()?SOLVER_EXTENSION:null;if(ext)ensureRelay().catch(()=>{});
   return target.launchPersistentContext(dir,launchOptions(o,{stealthArgs,extension:ext}));
  };
  const v=target[prop];return typeof v==='function'?v.bind(target):v;
 }});
}
