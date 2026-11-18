// Local JSON bridge for the dashboard: no model, browser, mail or application side effects.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {learnApprovals,loadAnswers,sharedEligible} from '../src/companies.mjs';
import {draftExamples,suggestedDraft,draftProjects,isShortAnswer,projectDraft,resumeDraft} from '../src/answer-learning.mjs';
import {resolveKnownQuestion} from '../src/dashboard-worker.mjs';
let input='';for await(const chunk of process.stdin)input+=chunk;
const request=JSON.parse(input);
if(request.action==='learn'){
 const learned=await learnApprovals(request.bankDir,request.company,request.approvals,request.jobId);
 console.log(JSON.stringify({...learned,sharedQuestions:request.approvals.filter(a=>sharedEligible(a.question,a.answer,request.company,a.type)).map(a=>a.question)}));
}else if(request.action==='suggest'){
 const profile=JSON.parse(await readFile(request.profilePath,'utf8'));
 const examples=await draftExamples(request.bankDir);
 const projects=draftProjects(profile);
 const result=[];
 for(const item of request.items){
  const {answers:bank}=await loadAnswers(request.bankDir,item.company);
  let job={};try{job=JSON.parse(await readFile(join(request.runDirectory,item.id,'request.json'),'utf8')).job;}catch{}
  job={...job,...item};
  const facts={},drafts={};
  for(const question of item.questions??[]){
   const label=question.label;
   const factualTextarea=/^(?:Please state your name and current date in the box below|Which company are you currently employed with|In which city and state are you located|(?:please (?:provide|enter|list) your |what is your )?(?:current |home |mailing )?(?:street )?address\??$)/i.test(label);
   if(!isShortAnswer(question)&&(question.type!=='textarea'||factualTextarea)){
    const known=resolveKnownQuestion({question,profile,bank,job});
    if(known.resolved)facts[label]=known.value;
   }
   if(!Object.hasOwn(facts,label)&&isShortAnswer(question)){
    let draft=suggestedDraft(label,examples,{company:item.company,maxWords:question.maxWords});
    const context={company:item.company,title:job.title,description:job.description??job.description_text??'',maxWords:question.maxWords};
    draft=projectDraft(label,draft,projects,context)??resumeDraft(label,profile,context);
    if(draft)drafts[label]=draft;
   }
  }
  result.push({job_id:item.job_id,facts,drafts});
 }
 console.log(JSON.stringify(result));
}else throw new Error('Unknown answer-memory action');
