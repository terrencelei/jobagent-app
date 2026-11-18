import { applicationChromium } from '../src/captcha-vendor.mjs';
const chromium = await applicationChromium();  // the CAPTCHA package's stealth.js launch
const b = await chromium.launch({headless:true});
const p = await (await b.newContext()).newPage();
await p.goto(process.argv[2], {waitUntil:'domcontentloaded', timeout:60000});
await p.waitForTimeout(8000);
console.log(JSON.stringify(await p.evaluate(() => {
  const out=[];
  document.querySelectorAll('div[class*="fieldEntry"]').forEach(fe => {
    const lab=(fe.innerText||'').split('\n')[0];
    fe.querySelectorAll('input,select,textarea').forEach(e=>{
      out.push({label:lab.slice(0,42), tag:e.tagName, type:e.type, id:e.id, name:e.name,
        req: e.required || e.getAttribute('aria-required')==='true',
        ph: e.placeholder||'', val:e.value?.slice(0,20)});
    });
  });
  return out;
}), null, 0).replace(/\},/g,'},\n'));
await b.close();
