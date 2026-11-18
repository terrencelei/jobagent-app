// Employer pages can render their job description before Greenhouse injects its iframe.
const embedSelector='#grnhse_app, iframe[src*="greenhouse.io/embed/job_app"]';
function greenhouseEmbed(url) {
 try {const u=new URL(url);return /(^|\.)(?:greenhouse\.io)$/.test(u.hostname)&&u.pathname==='/embed/job_app';}catch{return false;}
}
export async function waitForEmbeddedApplication(page,{timeout=20000,pollMs=100}={}) {
 if(!await page.locator(embedSelector).count())return true;
 const deadline=Date.now()+timeout;
 do {
  for(const frame of page.frames()){
   if(!greenhouseEmbed(frame.url()))continue;
   const ready=await frame.locator('input:not([type=hidden]):not([type=file]):not([type=submit]):not([type=button]),textarea,select').evaluateAll(fields=>fields.some(el=>el.getClientRects().length&&!el.disabled)).catch(()=>false);
   if(ready)return true;
  }
  if(Date.now()>=deadline)return false;
  await new Promise(resolve=>setTimeout(resolve,Math.min(pollMs,deadline-Date.now())));
 }while(!page.isClosed());
 return false;
}
