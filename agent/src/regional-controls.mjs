import {regionalAnswer} from './location-policy.mjs';

const canonical=value=>String(value??'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()
 .replace(/\bcalifornia\b/g,'ca').replace(/\bunited states(?: of america)?\b/g,'usa').replace(/\bus\b/g,'usa');

// Resume parsing can overwrite an already populated location. Reuse the normal
// approved-value/fill path for the applicant's explicit regional rule.
// One correction per control state: Lever's location typeahead clears a typed value on
// blur unless a suggestion was picked, and refilling it after every other field consumed
// the whole step budget (Shield AI 12230). A value the page did not keep is not retried.
export function regionalLocationCorrection(snap,profile,job,attempts=new Set()){
 for(const frame of snap.frames??[])for(const control of frame.controls??[]){
  if(control.historySection||!control.inForm||!(/^(?:current )?(?:city|location)(?: and state)?\s*[?*]*$/i.test(control.label)))continue;
  if(!control.combobox&&!['text','search','combobox'].includes(control.type))continue;
  const answer=regionalAnswer(control.label,profile,job);
  if(!answer?.value||canonical(control.value)===canonical(answer.value))continue;
  const signature=JSON.stringify([snap.url,control.nodeKey??control.domId??control.name??control.id,control.label,control.value,answer.value]);
  if(attempts.has(signature))continue;
  attempts.add(signature);
  return control;
 }
 return null;
}
