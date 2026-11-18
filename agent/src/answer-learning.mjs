// Reuse approved examples as drafts only. A similar question never authorizes prose.
import {readdir} from 'node:fs/promises';
import {loadBank, companySlug} from './companies.mjs';
import {shouldApproveOptionalWriting} from './application-writing-policy.mjs';

export function proseTopic(label) {
 const q=String(label);
 // Demographic self-identification is never prose, however it is worded.
 if(/\b(?:race|racial|ethnic|ethnicity|gender|pronouns?|veteran|disability|sexual orientation|hispanic|latino)\b/i.test(q))return null;
 const optionalWriting=shouldApproveOptionalWriting({label:q,type:'text'});
 if(optionalWriting&&(/^(?:\s*why\s+(?:you|me)\b)|(?:good|great|strong|best|ideal).*(?:fit|candidate)|what.*(?:bring|contribute)|why.*(?:hire|choose|select).*you/i.test(q)))return 'candidate-fit';
 if(/\bwhat\b.*\b(?:interested|interests|motivates|motivated)\b.*\b(?:apply|application|join|role|position|company)\b/i.test(q))return 'motivation';
 if(optionalWriting&&(/^\s*why\b|why.*(?:us|join|work|company|interested)|what.*(?:excites|excited)|(?:motivat|interest).*?(?:company|role|position|apply|application)/i.test(q)))return 'motivation';
 if(/challeng|(?:technical|engineering).*problem|problem.*technical/i.test(q))return 'technical-challenge';
 if(/impressive|proudest|proud of|accomplishment|achievement/i.test(q))return 'proudest-project';
 if(/exceptional ability|evidence of.*(?:ability|excellence)/i.test(q))return 'exceptional-ability';
 if(/(?:electromechanical|hardware|mechanical).*(?:project|system).*(?:built|worked|design)|(?:describe|tell).*(?:electromechanical|hardware).*project/i.test(q))return 'hardware-project';
 if(/prototyp|fabricat|machine shop/i.test(q))return 'prototyping';
 if(/\b(?:describe|tell|share|explain|discuss)\b.*\bsomething you (?:built|made|created)\b/i.test(q)||optionalWriting&&/\b(?:describe|tell|share|explain|discuss)\b.*\b(?:projects?|contributions?|strengths?|experience|yourself|background)\b/i.test(q))return 'experience';
 return null;
}

export async function draftExamples(dir) {
 let files;try{files=await readdir(dir);}catch(e){if(e.code==='ENOENT')return [];throw e;}
 const examples=[];
 for(const file of files.filter(f=>f.endsWith('.json')&&!f.startsWith('_'))){
  const bank=await loadBank(dir,file.slice(0,-5));
  for(const [key,a] of Object.entries(bank.answers??{})){
   // A reusable prose example is at least a sentence; short factual answers never seed drafts.
   if(key.startsWith('intent:')||!a.question||!a.approvedAt||typeof a.answer!=='string'||a.answer.trim().split(/\s+/).length<8)continue;
   const topic=proseTopic(a.question);if(!topic)continue;
   examples.push({...a,company:bank.company,topic});
  }
 }
 return examples.sort((a,b)=>String(b.approvedAt).localeCompare(String(a.approvedAt)));
}

export function suggestedDraft(label,examples,{company='',maxWords}={}) {
 const topic=proseTopic(label);if(!topic)return null;
 const example=examples.find(a=>{
  if(a.topic!==topic)return false;
  if(topic==='motivation'&&companySlug(a.company??'')!==companySlug(company))return false;
  // An employer's name in approved prose stays local; never swap company names.
  if(companySlug(a.company??'')!==companySlug(company)&&String(a.company??'').trim().length>=3&&a.answer.toLowerCase().includes(a.company.toLowerCase().trim()))return false;
  if(maxWords&&a.answer.trim().split(/\s+/).length>maxWords)return false;
  return true;
 });
 return example?{draft:example.answer,note:'Draft based on your approved answer to a similar question. Review and edit before approving.',draftSource:{company:example.company,question:example.question,approvedAt:example.approvedAt}}:null;
}

// Project write-ups the applicant asked to feature in every short-answer draft
// (profile.projects[] with includeInProseDrafts). Drafts only: approval still gates submission.

export function draftProjects(profile) {
 return (profile?.projects??[]).filter(p=>p?.includeInProseDrafts&&p.drafts?.intro&&p.drafts?.short);
}

export function isShortAnswer(question) {
 if(question?.options?.length)return false;
 if(shouldApproveOptionalWriting({...question,required:false}))return true;
 if(!['text','textarea'].includes(question?.type)&&!question?.maxWords)return false;
 // A textarea or word limit does not make a school/date/personal fact a story.
 // Generate prose only for an identified narrative intent.
 return Boolean(proseTopic(question.label));
}

const words=s=>String(s).trim().split(/\s+/).filter(Boolean).length;
// Employer motivation must be drafted for this employer, not repurposed from another.
// Terms are included only when both the posting and confirmed project wording support them.
function motivationDraft(project,{company='',title='',description='',maxWords}={}) {
 const employer=String(company).trim(),role=String(title).trim();
 if(!employer)return null;
 const d=project.drafts;
 const projectText=Object.values(d).join(' ');
 const focus=['robotics','mechanical design','testing','manufacturing','automation','control','simulation','ROS 2']
  .find(term=>new RegExp(`\\b${term}\\b`,'i').test(description)&&new RegExp(`\\b${term}\\b`,'i').test(projectText));
 const interest=`I am interested in ${role?`the ${role} role at ${employer}`:`working at ${employer}`} and the opportunity to build on my engineering project experience.`;
 const connection=focus?`The posting's focus on ${focus} connects with that work.`:'';
 const variants=[`${interest} ${d.intro} ${d.contribution??''} ${connection}`,`${interest} ${d.short} ${connection}`,`${interest} ${d.short}`];
 const draft=variants.map(s=>s.replace(/\s+/g,' ').trim()).find(s=>!maxWords||words(s)<=maxWords);
 if(!draft)return null;
 return {draft,note:`Draft for ${employer}, based only on this role and your confirmed project wording. Review your motivation and edit before approving.`,draftSource:{project:project.key,company:employer,title:role}};
}

export function projectDraft(label,base,projects,context={}) {
 // Keep the applicant's approved edit intact when proposing it again for review.
 if(base)return base;
 const topic=proseTopic(label);if(!topic)return null;
 const project=projects[0];if(!project)return null;
 const {maxWords}=context;
 const d=project.drafts;
 if(topic==='motivation')return motivationDraft(project,context);
 const order=topic==='technical-challenge'?['intro','challenge','approach','contribution']
  :topic?['intro','contribution','challenge']:['intro','contribution'];
 const parts=order.map(k=>d[k]).filter(Boolean);
 while(parts.length>1&&maxWords&&words(parts.join(' '))>maxWords)parts.pop();
 let draft=parts.join(' ');
 if(maxWords&&words(draft)>maxWords)draft=d.short;
 if(maxWords&&words(draft)>maxWords)return null;
 return {draft,note:`Draft built from your ${String(project.sponsor??project.name??'confirmed project').split(' ')[0]} capstone (profile.json projects). Tailor it to this question before approving; what you approve is submitted word for word.`,draftSource:{project:project.key}};
}


// Fall back to recorded résumé facts when no opted-in project/example can draft
// the answer. Education says "studied", never that a degree has been completed.
export function resumeDraft(label,profile,context={}) {
 const topic=proseTopic(label);if(!topic)return null;
 const {company='',title='',maxWords}=context;
 const education=(profile?.education??[]).find(e=>e.field&&e.school);
 const study=education?`My educational background includes studies in ${education.field} at ${education.school}.`:'';
 const histories=(profile?.workHistory??[]).filter(h=>h.title&&h.company&&h.description);
 const work=topic==='technical-challenge'?histories.find(h=>/challeng|problem|failure|root cause|constraint|timeline/i.test(h.description)):histories[0];
 const experience=work?`In my work as ${work.title} at ${work.company}: ${work.description}`:'';
 let variants=[];
 if(topic==='motivation'){
  if(!company)return null;
  const interest=`I am interested in ${title?`the ${title} role at ${company}`:`working at ${company}`} as an opportunity to apply and develop my engineering experience.`;
  if(study||experience)variants=[`${interest} ${study} ${experience}`,`${interest} ${study||experience}`];
 }else if(topic==='candidate-fit'){
  variants=[`${study} ${experience}`,study||experience];
 }else if(work){
  variants=[experience];
 }
 const draft=variants.map(s=>s.replace(/\s+/g,' ').trim()).find(s=>s&&(!maxWords||words(s)<=maxWords));
 if(!draft)return null;
 return {draft,note:'Draft based on your recorded résumé facts. Review how it answers this question and edit before approving; no degree completion or new achievement is inferred.',draftSource:{resume:true,...(work?{employer:work.company}:{}),...(education?{school:education.school}:{})}};
}
