// His current employer is the one work-history entry without an end date. Résumé parsers at Lever,
// Ashby, Greenhouse and others prefill "Current company" / "Current title" from the top résumé entry,
// which can be a sponsored capstone or project ("Capstone Student ... Present"): a sponsor never
// employed the student, so it must not be given as the current employer. These helpers
// answer the current-employer and current-title questions from the profile and correct a parsed value.
const canonical=value=>String(value??'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const COMPANY=/^(?:current|present|most recent|current or most recent|current\/most recent|latest)\s+(?:company|employer|organization|organisation)(?:\s+name)?\s*[?*:]*$/i;
const TITLE=/^(?:current|present|most recent|current or most recent|current\/most recent|latest)\s+(?:job\s+)?(?:title|position|role)(?:\s+title)?\s*[?*:]*$/i;

// His instruction (2026-10-23): he has no current employer. Current-company/title fields stay blank when
// optional and get "N/A" when required, whatever the work history or a résumé parser suggests.
export const noCurrentEmployer=(profile={})=>profile.answers?.noCurrentEmployer===true;

// The single row still running; two open rows or none means nothing can be asserted.
export function currentEmployment(profile={}){
 if(noCurrentEmployer(profile))return null;
 const rows=(profile.workHistory??[]).map((row,index)=>({...row,index})).filter(row=>row.to===null||row.to===undefined||row.current===true);
 if(rows.length!==1||!rows[0].company)return null;
 const flags=(profile.answers?.confirmedEmploymentCompanies??[]).filter(flag=>canonical(flag.company)===canonical(rows[0].company));
 if(flags.some(flag=>flag.current===false))return null;
 return {index:rows[0].index,company:String(rows[0].company),title:rows[0].title?String(rows[0].title):undefined};
}

// Organizations that look like employers on the résumé but are not: project sponsors.
export function nonEmployers(profile={}){
 return (profile.projects??[]).map(project=>String(project.sponsor??'').replace(/\s*\(.*?\)\s*/g,' ').trim()).filter(Boolean);
}

export function currentEmployerFacts(profile={}){
 const current=currentEmployment(profile);
 if(!current)return {};
 const facts={currentEmployer:current.company};
 if(current.title)facts.currentJobTitle=current.title;
 return facts;
}

// The confirmed value for a standalone current-employer or current-title field, or undefined when the
// label is something else (work-history rows carry historySection and are matched separately).
export function currentEmployerAnswer(label,profile={}){
 const q=String(label??'').trim();
 if(noCurrentEmployer(profile)&&(COMPANY.test(q)||TITLE.test(q)))return {key:'noCurrentEmployer',value:'N/A',blankWhenOptional:true};
 const current=currentEmployment(profile);
 if(COMPANY.test(q))return current?{key:'currentEmployer',value:current.company}:null;
 if(TITLE.test(q))return current?.title?{key:'currentJobTitle',value:current.title}:null;
 return undefined;
}

// A prefilled current-employer/title field that disagrees with the profile (a résumé parser wrote the
// capstone sponsor there) is refilled through the normal fill path, once per observed value.
export function currentEmployerCorrection(snap,profile,attempts=new Set()){
 for(const frame of snap.frames??[])for(const control of frame.controls??[]){
  if(control.historySection||!control.inForm||!String(control.value??'').trim())continue;
  if(!control.combobox&&!['text','search','combobox'].includes(control.type))continue;
  const answer=currentEmployerAnswer(control.label,profile);
  // No current employer: an optional field a parser prefilled is cleared, a required one becomes N/A.
  const wanted=answer?.blankWhenOptional&&!control.required?'':answer?.value;
  if(answer?.blankWhenOptional?canonical(control.value)===canonical(wanted):(!answer?.value||canonical(control.value)===canonical(answer.value)))continue;
  const signature=JSON.stringify([snap.url,control.nodeKey??control.domId??control.name??control.id,control.label,control.value,answer.value]);
  if(attempts.has(signature))continue;
  attempts.add(signature);
  return {control,fact:answer.key};
 }
 return null;
}

// Any employer-named field (standalone or a history row) holding a sponsor's name: reported at review so
// a parsed row is never submitted as employment.
export function sponsorAsEmployerProblems(controls,profile){
 const sponsors=nonEmployers(profile).map(canonical).filter(Boolean);
 if(!sponsors.length)return [];
 return (controls??[]).filter(control=>/(?:company|employer|organization|organisation)/i.test(String(control.label))&&!['button','submit','a','file','password'].includes(control.type)&&sponsors.some(s=>canonical(control.value)===s||canonical(control.value).startsWith(s+' ')))
  .map(control=>`${control.label} is "${control.value}", a project sponsor rather than an employer`);
}
