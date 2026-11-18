// Recover only blank, required plain contact fields from explicit saved facts.
// Choice controls, consent, credentials and application prose stay with their
// existing approval paths. A leading required-marker span is presentation.
export function requiredContacts(snap,profile){
 const keys={'first name':'firstName','last name':'lastName','full name':'fullName','email':'email','email address':'email','phone':'phone','phone number':'phone'};
 const result=[];
 for(const frame of snap.frames??[])for(const control of frame.controls??[]){
  if(!control.inForm||!control.required||control.value||control.combobox||!['text','email','tel'].includes(control.type))continue;
  // Waymo (13548) spells the marker out as "First Name (required)" instead of an asterisk.
  const label=String(control.label).replace(/^\s*\*\s*|\s*\*\s*$/g,'').replace(/\s*\((?:required|optional)\)\s*$/i,'').replace(/\s+/g,' ').trim().toLowerCase();
  const fact=keys[label],value=fact&&profile.answers?.[fact];
  if(typeof value==='string'&&value.trim())result.push({frameIndex:frame.frameIndex,control,value});
 }
 return result;
}

// Decline optional cookies only in a recognizable consent banner. Never accept
// all cookies or click an unrelated application choice bearing the same text.
// OneTrust on ADP myjobs (Toyota Automated Logistics 12808) labels them Deny / Agree and proceed.
export async function declineOptionalCookies(page){
 const candidates=page.getByRole('button',{name:/^(?:click to )?(?:(?:decline|reject) all(?: cookies)?|(?:decline|reject) (?:optional )?cookies|deny(?: all)?|i do not accept|i don'?t accept|i decline)$/i});
 const eligible=[];
 for(let i=0;i<await candidates.count();i++){
  const button=candidates.nth(i);
  if(!await button.isVisible())continue;
  const banner=await button.evaluate(el=>{
   // A modal labelled as the cookie consent dialog holds its own category toggles and a form (Waymo 13548:
   // "I do not accept" / "I accept" / Manage Cookies, with a static backdrop that blocks every click on the page).
   const dialog=el.closest('[role=dialog],[role=alertdialog],dialog');
   if(dialog&&/\bcookie/i.test(`${dialog.getAttribute('aria-label')??''} ${dialog.id} ${dialog.className}`)&&!dialog.querySelector('input[type=file],textarea'))return true;
   for(let parent=el.parentElement,depth=0;parent&&parent!==document.body&&depth<5;parent=parent.parentElement,depth++){
    if(parent.matches('form')||parent.closest('form'))return false;
    if(parent.querySelector('form,input,textarea,select'))continue;
    if(/\bcookies?\b/i.test(parent.innerText)&&[...parent.querySelectorAll('button')].some(b=>/^(?:click to )?(?:i )?(?:accept(?: all)?(?: cookies)?|allow all(?: cookies)?|agree and proceed)$/i.test(b.innerText.trim())))return true;
   }return false;
  });
  if(banner)eligible.push(button);
 }
 if(eligible.length!==1)return false;
 // Declining is optional: a banner that hides itself or is covered mid-click (Karman/ADP 12729) must not stop the run.
 try{await eligible[0].click({timeout:3000});return true;}catch{return false;}
}
