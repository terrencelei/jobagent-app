import {questionId} from './companies.mjs';

// A DOM control proves that its internal name and visible label refer to one
// question. An older approval under that name must not make the step agent
// fight the newer visible-label approval already used by the worker.
export function decisionAnswerBank(bank={},snap={},job={},approvedAnswers=[]) {
 const answers={...bank},supersededAnswerAliases={};
 const labelsByName=new Map();
 for(const control of (snap.frames??[]).flatMap(f=>f.controls??[])){
  if(!control.name||!control.label)continue;
  const name=questionId(control.name),label=questionId(control.label);
  if(!labelsByName.has(name))labelsByName.set(name,new Set());
  labelsByName.get(name).add(label);
 }
 if(job.id===undefined||job.id===null)return {answers,supersededAnswerAliases};
 for(const [name,labels] of labelsByName){
  if(labels.size!==1)continue;
  const [label]=labels,alias=bank[name],current=bank[label];
  if(name===label||!alias||!current)continue;
  if(alias.shared===true||current.shared===true)continue;
  if(String(alias.approvedFor)!==String(job.id))continue;
  if(typeof alias.answer!=='string'||typeof current.answer!=='string'||!current.answer.trim()||alias.answer===current.answer)continue;
  const currentRequest=approvedAnswers.some(a=>typeof a.question==='string'&&questionId(a.question)===label&&a.answer===current.answer);
  const oldTime=Date.parse(alias.approvedAt),newTime=Date.parse(current.approvedAt);
  if(!currentRequest&&(String(current.approvedFor)!==String(job.id)||!Number.isFinite(oldTime)||!Number.isFinite(newTime)||newTime<=oldTime))continue;
  delete answers[name];supersededAnswerAliases[name]=label;
 }
 return {answers,supersededAnswerAliases};
}
