#!/usr/bin/env node
// What a page can tell about the relay Chrome while the worker drives it (2026-11-01).
// Lever's hCaptcha served image rounds to the hidden relay Chrome on every run (Zoox 8d7df8c7, Field AI
// a9cdda47, TRI 59214d92), so this measures the automation tells a page script can read, the same way the
// worker attaches: a plain Chrome on its own probe profile, connected over its DevTools port.
//
//   node tools/fingerprint-probe.mjs [--engine playwright] [--hcaptcha N] [--profile DIR]
//
// The detection page is served from 127.0.0.1 and writes its findings into the DOM, so reading them back
// never runs script in the page's world. --hcaptcha N also clicks the hCaptcha demo checkbox N times with
// humanlike mouse movement and reports whether it passed without an image round (the score signal).
import {createServer} from 'node:http';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchRelayChrome,keepHidden} from '../src/human-chrome.mjs';
import {humanMove} from '../src/human-input.mjs';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
const arg=(name,fallback)=>{const i=process.argv.indexOf('--'+name);return i>0?process.argv[i+1]:fallback;};
const engine=arg('engine','playwright');
const rounds=Number(arg('hcaptcha','0'))||0;
const profile=arg('profile',join(ROOT,'private/relay-chrome-probe'));

// Runs inside the probed page. Every check is one a public bot-detection script uses.
const DETECT=`<!doctype html><title>probe</title><pre id=out>pending</pre><script>
(async()=>{
 const r={};
 r.webdriver=navigator.webdriver;
 r.headlessUA=/Headless/.test(navigator.userAgent);
 r.brands=(navigator.userAgentData?.brands||[]).map(b=>b.brand).join(', ');
 r.plugins=navigator.plugins.length;
 r.languages=navigator.languages.join(',');
 r.chromeRuntime=typeof window.chrome==='object'&&'runtime' in window.chrome;
 // CDP Runtime.enable: DevTools serialises console arguments, which reads Error.stack.
 let cdp=false;const e=new Error('probe');Object.defineProperty(e,'stack',{configurable:true,get(){cdp=true;return '';}});console.debug(e);
 // Playwright / Puppeteer / Selenium globals left in the page world.
 r.automationGlobals=Object.getOwnPropertyNames(window).filter(k=>/playwright|__pw|puppeteer|cdc_|\\$cdc|webdriver|selenium|domAutomation/i.test(k));
 // Runtime.enable makes V8 build console previews, which runs a Proxy's traps (still works on current Chrome).
 let proxyHit=false;console.debug(new Proxy({},{ownKeys(){proxyHit=true;return [];},getOwnPropertyDescriptor(){proxyHit=true;}}));
 let errHit=false;const e2=new Error('x');Object.defineProperty(e2,'message',{get(){errHit=true;return 'x';}});console.debug(e2);
 r.notificationPermission=Notification.permission;
 try{r.permissionQuery=(await navigator.permissions.query({name:'notifications'})).state;}catch(x){r.permissionQuery='error';}
 r.outerSize=outerWidth+'x'+outerHeight;r.innerSize=innerWidth+'x'+innerHeight;
 r.hasFocus=document.hasFocus();r.visibility=document.visibilityState;
 await new Promise(s=>setTimeout(s,300));r.cdpRuntimeEnabled=cdp;r.cdpProxyPreview=proxyHit;r.cdpErrorMessage=errHit;
 document.getElementById('out').textContent=JSON.stringify(r);
})();</script>`;

const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(DETECT);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/`;

const {chromium}=await import(engine);
const marker='probe-'+Date.now();
const stopHiding=keepHidden(profile);
const endpoint=await launchRelayChrome(profile,{marker,extensions:[]});
const browser=await chromium.connectOverCDP(endpoint);
const context=browser.contexts()[0];
const page=context.pages().find(p=>p.url().endsWith('#'+marker))??await context.newPage();
const report={engine};
try{
 await page.goto(url);
 await page.locator('#out').filter({hasNotText:'pending'}).waitFor({timeout:10000});
 report.page=JSON.parse(await page.locator('#out').textContent());
 if(rounds){
  report.hcaptcha=[];
  for(let i=0;i<rounds;i++){
   await page.goto('https://accounts.hcaptcha.com/demo',{waitUntil:'domcontentloaded'});
   const box=page.frameLocator('iframe[src*="hcaptcha"][src*="checkbox"]').locator('#checkbox');
   await box.waitFor({timeout:20000});await page.waitForTimeout(1500+Math.random()*1500);
   const b=await box.boundingBox();await humanMove(page,b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.waitForTimeout(60+Math.random()*80);await page.mouse.up();
   let outcome='timeout';
   for(let t=0;t<40;t++){
    await page.waitForTimeout(500);
    if((await box.getAttribute('aria-checked').catch(()=>null))==='true'){outcome='passed without a challenge';break;}
    const shown=await page.locator('iframe[src*="hcaptcha"][src*="challenge"]').evaluateAll(fs=>fs.some(f=>f.getBoundingClientRect().height>100&&getComputedStyle(f.parentElement.parentElement).visibility!=='hidden')).catch(()=>false);
    if(shown){outcome='image challenge';break;}
   }
   report.hcaptcha.push(outcome);
  }
 }
}finally{
 await page.close().catch(()=>{});await browser.close().catch(()=>{});stopHiding();server.close();
}
console.log(JSON.stringify(report,null,1));
process.exit(0);
