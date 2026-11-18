// Ashby renders its application shell before the asynchronous form arrives.
export function ashbyApplicationPage(url) {
 try {const u=new URL(url);return u.hostname==='jobs.ashbyhq.com'&&/\/application\/?$/.test(u.pathname);}catch{return false;}
}
export async function waitForAshbyForm(page,{timeout=45000}={}) {
 const ready=await page.waitForFunction(()=>{
  const email=document.getElementById('_systemfield_email');
  const name=document.getElementById('_systemfield_name');
  // A removed posting never loads the form; stop waiting so ashbyJobNotFound can say so.
  if(document.querySelector('h1')?.innerText.trim()==='Job not found')return true;
  return Boolean(email?.getClientRects().length&&name?.getClientRects().length&&!email.disabled&&!name.disabled);
 },{},{timeout}).then(()=>true,()=>false);
 return ready&&!(await ashbyJobNotFound(page));
}
// Ashby answers a removed job with HTTP 200 and a "Job not found" page, not an error status.
export async function ashbyJobNotFound(page) {
 return page.evaluate(()=>document.querySelector('h1')?.innerText.trim()==='Job not found'&&
  /The job you requested was not found/i.test(document.body?.innerText??'')).catch(()=>false);
}
