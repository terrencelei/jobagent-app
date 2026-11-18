// Labels of required controls that would make the browser refuse to submit this control's form.
export async function formValidationGaps(locator){
 return locator.evaluate(el=>{
  const form=el.form??el.closest('form');
  if(!form||form.noValidate||el.formNoValidate)return [];
  const seen=new Set(),gaps=[];
  for(const c of form.elements){
   if(!c.willValidate||c.validity.valid)continue;
   // Dropdown libraries' aria-hidden required twin is skipped here as in snapshot().
   if(c.getAttribute('aria-hidden')==='true'&&c.tabIndex<0)continue;
   const group=c.closest('fieldset,[role="radiogroup"],[role="group"]');
   // Array-valued checkbox questions use required on every alternative even
   // though the employer validates the question as pick-at-least-one.
   const choices=c.type==='checkbox'&&c.name.endsWith('[]')&&group?.matches('fieldset.checkbox[aria-required="true"]')
    ? [...group.querySelectorAll('input[type="checkbox"]')].filter(x=>x.form===form) : [];
   const choiceGroup=choices.length>1&&choices.every(x=>x.name===c.name&&x.required&&x.getAttribute('description')===c.getAttribute('description'))&&Boolean(c.getAttribute('description'));
   if(choiceGroup&&c.validity.valueMissing&&!c.validity.customError&&choices.some(x=>x.checked&&!x.disabled))continue;
   const key=choiceGroup?group:c.type==='radio'?`radio:${c.name}`:c;if(seen.has(key))continue;seen.add(key);
   const text=((choiceGroup&&group.querySelector('legend')?.innerText)||c.labels?.[0]?.innerText||group?.querySelector('legend,label,[id$="label"]')?.innerText||c.getAttribute('aria-label')||c.name||'Unlabelled field').replace(/\s+/g,' ').trim();
   gaps.push(text.slice(0,160));
  }
  return gaps;
 }).catch(()=>[]);
}

// Required non-resume upload fields (cover letter, transcript...) that still hold no file.
// The browser's own validity check misses them because employers validate uploads in script.
export function requiredUploadGap(c){
 return c?.type==='file'&&c.required&&!c.attached&&!/r[eé]sum[eé]|\bcv\b|curriculum/i.test(c.label);
}
export function missingRequiredUploads(controls){
 return controls.filter(requiredUploadGap).map(c=>c.label);
}
