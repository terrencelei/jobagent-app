// Keep an existing DOM node distinguishable from a second control with the same label.
// Replaced nodes still need a unique semantic match; never fall back to a stale ordinal ID.
export function rebindControl(original, controls) {
 const offered=controls.filter(c=>c.type===original.type&&c.label===original.label&&c.href===original.href);
 const sameNode=original.nodeKey?offered.filter(c=>c.nodeKey===original.nodeKey):[];
 if(sameNode.length===1)return sameNode[0];
 const byId=original.domId?offered.filter(c=>c.domId===original.domId):[];
 const byName=original.name?offered.filter(c=>c.name===original.name):[];
 const matches=byId.length?byId:byName.length?byName:offered;
 return matches.length===1?matches[0]:null;
}

// Compare semantic fields, ignoring generated IDs, DOM replacement and filled values.
// Late fields or caller-validated preparation navigation need a new decision.
export function hasNewFormControls(before,after,isPreparationNavigation=()=>false){
 const keys=snap=>(snap.frames??[]).flatMap(frame=>(frame.controls??[])
  .filter(c=>!['a','button','submit','reset','hidden'].includes(c.type)||isPreparationNavigation(c,frame))
  .map(c=>JSON.stringify([frame.frameIndex,frame.url,c.type,c.label,c.name,c.domId,c.href])));
 const previous=new Set(keys(before));
 return keys(after).some(key=>!previous.has(key));
}

// Classify the current page, rather than historical/negated words in a model
// message. Recognized ordinary sign-in forms can be reread; ambiguous credentials,
// code and CAPTCHA gates retain the normal human stop. This grants no auth permission.
export function hasVerificationControls(snap,{passwordSigninAllowed=()=>false}={}){
 return (snap.frames??[]).some(frame=>{
  const controls=frame.controls??[];
  const ordinarySignin=controls.filter(c=>c.type==='password').length===1 &&
   controls.some(c=>c.type==='email'||c.type==='text'&&/^(?:e-?mail(?: address)?|user ?name)\s*[:*]*$/i.test(c.label??'')) &&
   controls.some(c=>['button','submit','a'].includes(c.type)&&/^(?:sign[ -]in|log[ -]?in|log on)$/i.test((c.label??'').trim()));
  // Some identity providers split email and password into separate pages. A
  // caller-validated auth host and an explicit password sign-in heading allow
  // a fresh decision, never a credential fill or a verification bypass.
  const passwordSignin=passwordSigninAllowed(frame)&&
   /^\s*Enter your password\s*$/im.test(frame.text??'')&&
   controls.filter(c=>!['a','button','submit','reset','hidden'].includes(c.type)).length===1&&
   controls.some(c=>c.type==='password'&&/^password\s*[:*]*$/i.test(c.label??''))&&
   (controls.some(c=>['button','submit'].includes(c.type)&&/^(?:continue|sign[ -]in|log[ -]?in)$/i.test((c.label??'').trim()))||
    // Continue is often disabled until the password is entered, so it is absent
    // from actionable controls while its visible text remains on the page.
    /^\s*Continue\s*$/im.test(frame.text??'')&&!/\b(?:submit|send) application\b/i.test(frame.text??''));
  return /verify your email|enter (?:the |your )?(?:(?:six|6)[ -]digit )?(?:verification |security )?code/i.test(frame.text??'')||
  controls.some(c=>c.type==='password'&&!ordinarySignin&&!passwordSignin||/captcha|verification code|security code|one.time|passcode|\botp\b|not a robot/i.test(`${c.label??''} ${c.name??''} ${c.domId??''}`));
 });
}
