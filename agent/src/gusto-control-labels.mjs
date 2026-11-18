// Gusto custom questions use a label whose `for` ends in the question text,
// while the input id ends in `text`. Recover only the matching question group.
export async function gustoControlLabels(frame,controls){
 if(!controls.some(c=>/^job_applicant\[custom_form_response_attributes\]\[answers_attributes\]\[\d+\]/.test(c.name||'')))return;
 const labels=await frame.evaluate(()=>{
  const mapped={};
  for(const el of document.querySelectorAll('[data-ja-control][name]')){
   const match=el.name.match(/^job_applicant\[custom_form_response_attributes\]\[answers_attributes\]\[(\d+)\]/);
   if(!match)continue;
   const prefix=`job_applicant_custom_form_response_attributes_answers_attributes_${match[1]}_`;
   let group=el.parentElement;
   while(group&&group.tagName!=='FORM'){
    const markers=[...group.querySelectorAll('input[name$="[question_uuid]"]')];
    if(markers.length>1)break;
    if(markers.length===1&&markers[0].name===`${match[0]}[question_uuid]`){
     const headings=[...group.querySelectorAll('label[for]')].filter(l=>l.htmlFor.startsWith(prefix)&&!document.getElementById(l.htmlFor)&&l.getClientRects().length&&l.innerText.trim());
     if(headings.length===1){
      const label=headings[0].innerText.trim();
      const options=['radio','checkbox'].includes(el.type)?[...group.querySelectorAll('input')].filter(c=>c.name===el.name&&['radio','checkbox'].includes(c.type)).map(c=>c.labels?.[0]?.innerText.trim()).filter(Boolean):undefined;
      mapped[el.getAttribute('data-ja-control')]={label,options};
     }
     break;
    }
    group=group.parentElement;
   }
  }
  return mapped;
 });
 for(const control of controls){
  const found=labels[control.id];if(!found)continue;
  if(['radio','checkbox'].includes(control.type)){control.optionLabel??=control.label;control.choiceLabels=found.options;}
  control.label=found.label.slice(0,600);
 }
}
