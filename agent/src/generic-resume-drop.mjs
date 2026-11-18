// SmartRecruiters' one-click form (Intuitive 12315) opens with a résumé drop zone whose only label is
// "Choose a file or drop it here". The label names no document, so uploadDocument() refuses it and the run
// failed. On that host, the first such unlabeled file control before any résumé is uploaded is the résumé.
// Intuitive 12316 (lesson 414): the form has two identical zones. The top one parses a résumé to autocomplete
// the form; the real résumé field is the second one, under a "Resume" heading after Your Profiles. The step
// model reached that one and the first-zone rule refused it four times. The zone's own section heading now
// decides where it is known; the first-zone rule remains the fallback when no heading can be read.
const resumeHeading=/\b(r[ée]sum[ée]|cv|curriculum vitae)\b|autocomplete your application|autofill/i;
const otherDocumentHeading=/\b(cover letter|portfolio|transcript|additional|other|supporting) (documents?|attachments?|files?)\b|\bcover letter\b|\bportfolio\b|\btranscript\b/i;
export function dropZoneLabel(label){return /^(choose|select) a file( or drop it here)?\W*$/i.test(String(label??'').trim());}
export function genericResumeDrop(control,pageUrl,fileControls,resumeUploaded,heading){
 if(resumeUploaded||!control||!dropZoneLabel(control.label))return false;
 let host='';try{host=new URL(pageUrl).hostname}catch{return false}
 if(!/(^|\.)smartrecruiters\.com$/i.test(host))return false;
 const section=String(heading??'').trim();
 if(section){if(otherDocumentHeading.test(section))return false;if(resumeHeading.test(section))return true;}
 return fileControls[0]===control||fileControls[0]?.id===control.id&&fileControls[0]?.label===control.label;
}
// The nearest heading above a control, read across shadow roots: SmartRecruiters renders each drop zone inside a
// web component, so the "Resume" title is a sibling of the host, never of the input, and it is a custom element
// (<spl-typography-title>), not an <h2>. The enclosing component's own name (<oc-resume-upload>, <oc-apply-with-resume>)
// is appended because the title above the parser zone only says "Easy Apply".
export async function uploadZoneHeading(locator){
 return locator.evaluate(el=>{
  const selector='h1,h2,h3,h4,h5,h6,[role="heading"],[class*="title"],[class*="heading"]';
  const titleTag=node=>/title|heading/i.test(node.tagName);
  const heading=node=>{if(!(node instanceof Element))return '';if(/^H[1-6]$/.test(node.tagName)||node.getAttribute('role')==='heading'||titleTag(node))return node.textContent.trim();const inner=[...node.querySelectorAll(selector)].filter(n=>!/^(input|textarea|select)$/i.test(n.tagName)).pop();return inner?inner.textContent.trim():'';};
  let node=el,container='',text='';
  for(let depth=0;depth<40&&node&&!(text&&container);depth++){
   if(!container&&node instanceof Element&&node.tagName.includes('-')&&/resume|cv|cover|letter|attachment|portfolio|transcript/i.test(node.tagName))container=node.tagName.toLowerCase().replace(/-/g,' ');
   if(!text)for(let prev=node.previousSibling;prev&&!text;prev=prev.previousSibling)text=heading(prev).slice(0,120);
   const parent=node.parentNode;
   node=parent instanceof ShadowRoot?parent.host:parent instanceof Element?parent:null;
  }
  return [text,container].filter(Boolean).join(' · ');
 },null,{timeout:1500}).catch(()=>'');
}
