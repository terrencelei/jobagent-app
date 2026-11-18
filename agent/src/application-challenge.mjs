// A visible verification challenge after Submit is not an employer receipt.
// Every frame is checked: iCIMS renders the application inside an iframe, so its hCaptcha challenge is an iframe
// within that one (Rivian 12058 and siblings, 2026-11-01: the solver never ran because only top-level iframes were seen).
export async function visibleApplicationChallenge(page) {
 for(const frame of typeof page.frames==='function'?page.frames():[page]){
  const open=await frame.locator('iframe').evaluateAll(es=>es.some(el=>{
   const rect=el.getBoundingClientRect(),style=getComputedStyle(el);
   const title=el.getAttribute('title')||'',src=el.getAttribute('src')||'';
   return rect.width>150&&rect.height>100&&style.visibility!=='hidden'&&style.display!=='none'
     && (/recaptcha.*challenge|hcaptcha.*challenge|challenge.*captcha/i.test(title)||/recaptcha\/.*\/bframe|hcaptcha.*(?:challenge|frame=challenge)/i.test(src));
  })).catch(()=>false);
  if(open)return true;
 }
 return false;
}
