#!/usr/bin/env node
// Diagnose the CAPTCHA solver (the supplied package, vendor/captcha-solver) on one page, headless: open the URL, optionally click a
// selector (a Submit button that opens the challenge), name every bot check the page shows
// (identify) and, unless --identify-only, run the solver. Prints JSON; evidence lands under
// state/captcha-debug/<day>/<id>/. Vendor demo pages are the usual targets:
//   node tools/captcha-probe.mjs https://www.google.com/recaptcha/api2/demo
//   node tools/captcha-probe.mjs https://accounts.hcaptcha.com/demo --click 'input[type=submit]'
import {applicationChromium,vendorSolver,solveWithVendor} from '../src/captcha-vendor.mjs';

const chromium=await applicationChromium();
const {identify,vendorText}=vendorSolver();

const args=process.argv.slice(2);
const url=args.find(a=>!a.startsWith('--'));
if(!url){console.error('usage: node tools/captcha-probe.mjs <url> [--click <selector>] [--identify-only] [--wait <ms>]');process.exit(2);}
const opt=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
const click=opt('--click'),waitMs=Number(opt('--wait')||3000),identifyOnly=args.includes('--identify-only');

const browser=await chromium.launch({headless:true});
// the package's stealth.js sets the user agent and client hints, as in the application browsers
const context=await browser.newContext({viewport:{width:1280,height:1000}});
const page=await context.newPage();
const out={url,at:new Date().toISOString()};
try{
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForTimeout(waitMs);
 if(click){await page.locator(click).first().click({timeout:10000});await page.waitForTimeout(waitMs);}
 const before=await identify(page);
 out.before={vendors:before,text:vendorText(before)};
 if(!identifyOnly){
  out.result=await solveWithVendor(page,{company:'probe',url,log:m=>console.error(m)});
  const after=await identify(page);
  out.after={vendors:after,text:vendorText(after)};
 }
}catch(e){out.error=String(e?.message??e);}
finally{await browser.close().catch(()=>{});}
console.log(JSON.stringify(out,null,1));
