import {placeholderAnswer} from './companies.mjs';

const norm=v=>String(v??'').trim().replace(/\s+/g,' ').toLowerCase();
const FILLABLE=new Set(['text','email','tel','number','url','search','date','month','select-one','radio','checkbox']);

// Scripts only the step that has been proven across many runs: filling a field whose answer
// the worker's own resolvers already settle from his confirmed profile facts or an answer he
// approved. It proposes ONE fill; the worker still rebinds the control, re-resolves the value,
// fills it, verifies it was retained and runs every review and submission gate. Everything
// else (sign-in, navigation, final review, prose, history rows, uploads, anything unresolved or
// previously rejected) is left to the agent. Returns null when there is nothing safe to script.
export function scriptedFormAction({snap,profile,bank={},inline=new Map(),job={},history=[],attempts=new Set()},{resolveKnownQuestion,approvedValue}){
 // A rejected browser action needs interpretation, not a deterministic replay.
 if(history.at(-1)?.action==='rejected')return null;
 const controls=(snap.frames??[]).flatMap(f=>f.controls??[]);
 // Sign-in pages vary too much (SSO choosers, split pages, code gates); the agent handles them.
 if(controls.some(c=>c.type==='password'))return null;
 for(const c of controls){
  if(!FILLABLE.has(c.type)||c.combobox)continue;
  // Repeated work-history rows and skill ratings need row matching, not a profile lookup.
  if(c.historySection||c.historyCountry||c.skillRating)continue;
  const question={...c,options:c.options?.map(o=>o.label)??c.choiceLabels};
  let known;try{known=resolveKnownQuestion({question,profile,bank,job});}catch{continue;}
  if(!known?.resolved||!known.fact||placeholderAnswer(known.value))continue;
  // Approved prose belongs to one employer; textareas are excluded above, and bank entries
  // stand only for short exact answers (selects, yes/no, numbers).
  if(known.fact.startsWith('bank:')&&String(known.value).length>80)continue;
  const action={action:'fill',control:c.id,fact:known.fact,message:''};
  let value;try{value=approvedValue(action,c,profile,bank,inline,job.company,job);}catch{continue;}
  if(value===undefined||value===null||typeof value==='object')continue;
  if(['radio','checkbox'].includes(c.type)){
   if(typeof value!=='boolean'&&!['Yes','No','true','false'].includes(value))continue;
   const checked=value===true||value==='Yes'||value==='true';
   if(String(checked)===c.value)continue;
   // Selecting the confirmed radio changes the group; never clear the alternatives.
   if(c.type==='radio'&&!checked)continue;
  }else{
   if(norm(c.value)===norm(value)||norm(c.value)===norm(known.value))continue;
   if(c.options?.some(o=>o.value===c.value&&[norm(value),norm(known.value)].includes(norm(o.label))))continue;
   // A select must offer the resolved answer verbatim; near matches stay with the agent.
   if(c.options&&!c.options.some(o=>norm(o.label)===norm(value)))continue;
  }
  // One scripted attempt per control state: a fill that did not stick goes to the agent.
  const signature=JSON.stringify([snap.url,c.nodeKey??c.domId??c.name??c.id,c.label,c.type,c.value,known.fact,String(value)]);
  if(attempts.has(signature))continue;
  attempts.add(signature);
  return action;
 }
 return null;
}

