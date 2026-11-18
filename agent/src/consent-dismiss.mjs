// Cookie-consent banners and preference centres that sit over the page (OneTrust's dark filter at
// z-index 2147483645 covered a whole iCIMS viewport, so every CAPTCHA tile click and drag landed on
// the veil). dismiss() closes them in every frame: the least-consent choice first (reject all /
// necessary only / confirm choices), accept only when no such button exists, and as a last resort
// hides a known consent overlay that has no usable button. It never touches anything that is not
// consent UI.

// buttons, in order of preference (least consent first)
export const BUTTONS=[
 // OneTrust
 '#onetrust-reject-all-handler','.ot-pc-refuse-all-handler','button.save-preference-btn-handler',
 // Cookiebot
 '#CybotCookiebotDialogBodyButtonDecline','#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowallSelection',
 // TrustArc
 '#truste-consent-required','.truste_popframe .required',
 // Didomi / Usercentrics / Osano / CookieYes / Quantcast / Complianz / Iubenda
 '#didomi-notice-disagree-button','button[data-testid="uc-deny-all-button"]','.osano-cm-denyAll','.cky-btn-reject',
 '.qc-cmp2-summary-buttons button[mode="secondary"]','.cmplz-deny','.iubenda-cs-reject-btn',
 // accept fallbacks (only reached when no reject/necessary button is on screen)
 '#onetrust-accept-btn-handler','#accept-recommended-btn-handler','#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
 '#truste-consent-button','#didomi-notice-agree-button','button[data-testid="uc-accept-all-button"]','.osano-cm-accept-all',
 '.cky-btn-accept','.cmplz-accept','.iubenda-cs-accept-btn',
];
// overlays that are consent UI and nothing else: safe to hide when no button worked
export const OVERLAYS=['.onetrust-pc-dark-filter','#onetrust-consent-sdk','#CybotCookiebotDialog','#CybotCookiebotDialogBodyUnderlay',
 '.truste_overlay','.truste_box_overlay','#didomi-host','#usercentrics-root','.osano-cm-window','.cky-overlay','.cky-consent-container'];
// generic text buttons inside an element whose id/class says cookie/consent/gdpr
export const TEXT_RE=/^(reject all|reject|decline( all)?|deny( all)?|necessary (cookies )?only|only (necessary|essential)|use necessary cookies only|confirm (my )?choices|save (my )?(choices|preferences)|accept( all)?( cookies)?|i accept|allow all( cookies)?|agree|got it|ok)$/i;
const REJECT_RE=/reject|decline|deny|necessary|essential|confirm|save/i;
const CAPTCHA_FRAME=/hcaptcha|recaptcha|google\.com\/recaptcha|challenges\.cloudflare|arkoselabs|funcaptcha/;

export function dismissInFrame(frame){
 return frame.evaluate(({BUTTONS,OVERLAYS,TEXT_SRC,REJECT_SRC})=>{
  const vis=e=>{if(!e)return false;const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>2&&r.height>2&&s.visibility!=='hidden'&&s.display!=='none'&&+s.opacity>0.05;};
  for(const sel of BUTTONS){const b=document.querySelector(sel);if(vis(b)){b.click();return 'clicked '+sel;}}
  const TEXT=new RegExp(TEXT_SRC,'i'),REJECT=new RegExp(REJECT_SRC,'i');
  const hosts=[...document.querySelectorAll('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="gdpr" i], [class*="gdpr" i], [aria-label*="cookie" i]')].filter(vis);
  const cands=[];
  for(const h of hosts)for(const b of h.querySelectorAll('button, a[role="button"], [role="button"], input[type="button"]')){
   const t=(b.innerText||b.value||'').trim().replace(/\s+/g,' ');
   if(vis(b)&&TEXT.test(t))cands.push({b,t,rank:REJECT.test(t)?0:1});
  }
  cands.sort((a,b)=>a.rank-b.rank);
  if(cands[0]){cands[0].b.click();return 'clicked "'+cands[0].t+'"';}
  let hid=0;
  for(const sel of OVERLAYS)for(const e of document.querySelectorAll(sel))if(vis(e)){e.style.setProperty('display','none','important');hid++;}
  if(hid){if(document.body)document.body.style.overflow='';return 'hid '+hid+' overlay(s)';}
  return null;
 },{BUTTONS,OVERLAYS,TEXT_SRC:TEXT_RE.source,REJECT_SRC:REJECT_RE.source}).catch(()=>null);
}

// Close every consent UI on the page (all frames but CAPTCHA vendors'); returns what was done.
export async function dismissConsent(page,{rounds=3,wait=ms=>page.waitForTimeout(ms)}={}){
 const done=[];
 for(let i=0;i<rounds;i++){
  let acted=false;
  for(const f of page.frames()){
   if(CAPTCHA_FRAME.test(f.url()))continue;
   const r=await dismissInFrame(f);
   if(r){done.push(r);acted=true;}
  }
  if(!acted)break;
  await wait(700); // a reject button can open a confirmation layer (OneTrust preference centre)
 }
 return done;
}
