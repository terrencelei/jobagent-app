// Explicit applicant permissions for routine source and employer-history questions.
const norm=v=>String(v??'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const prose=/\b(?:why|describe|explain|tell|share|discuss|motivat\w*|interest\w*|good fit|strong fit)\b/i;
// A bare 'Source*' select of hiring channels (Virgin Galactic Phenom 13400, lesson 415) is the same question.
const sourceWording=q=>/\b(?:how|where) did you (?:first )?(?:hear|learn|find(?: out)?|come to know)\b|\bhow you (?:first )?(?:heard|learned|found)\b|\b(?:application|referral|recruitment|candidate) source\b/i.test(q)||/^(?:job |hiring )?source\s*\*?\s*:?$/i.test(String(q).trim());
// "Tell us how you heard about X" (Zipline 12921) is a source select, not a request for prose.
export const combinedSourceWritingQuestion=q=>sourceWording(q)&&prose.test(String(q).replace(/\btell us (?=how you\b)/i,''));
export function routineQuestionNeedsReview(q){
 if(combinedSourceWritingQuestion(q))return true;
 if(/\b(?:work|worked|working|employed|employment|employee|contractor)\b/i.test(q)&&(prose.test(q)||/^(?:when|where)\b|\b(?:provide|list|enter)\b.*\bdates?\b|\b(?:employment|work) dates?\b/i.test(q)))return true;
 // Country-specific authorization remains a confirmed fact, not employer history.
 if(/\b(?:authori[sz]\w*|legally|sponsorship|visa|work permit|right to work)\b/i.test(q))return false;
 return /\b(?:employed|employment|employee|contractor)\b|\b(?:work|worked|working)\s+(?:for|at|here)\b/i.test(q)&&/\b(?:willing|able|availability|available|relocat\w*|travel|skills?|experience|future|qualified|capable|prepared|plan|intend|going to)\b/i.test(q);
}
const sourceQuestion=q=>sourceWording(q)&&!combinedSourceWritingQuestion(q);
const employmentQuestion=(q,company='')=>/^(?:are|were|is|was|have|has|do|does|did)\b/i.test(q)&&!prose.test(q)&&!/\b(?:government|public|military|authorized|eligible|authorization|sponsorship|visa|permit|legally|right to work|contact|terminate|discharge|resign|willing|able|availability|available|relocat\w*|travel|skills?|experience|future|when|where|dates?|provide|details?|qualified|capable|prepared|plan|intend|going to)\b/i.test(q)&&/\b(?:employed|employment|employee|contractor)\b|\b(?:work|worked|working)\s+(?:for|at|here)\b/i.test(q)&&/\b(?:you|your|family|relative|spouse)\b/i.test(q)&&(/\b(?:us|our|here|this company|this organization)\b/i.test(q)||Boolean(company)&&` ${norm(q)} `.includes(` ${norm(company)} `));
export function routineApplicationAnswer(label,answers={},context={}) {
 const q=String(label).trim();
 const options=(context.options??[]).map(o=>typeof o==='string'?o:o.label).filter(Boolean);
 if(answers.routineSourceChoiceAllowed===true&&sourceQuestion(q)&&!/^describe|^explain|\b(?:name|who)\b.*\b(?:refer|employee)\b/i.test(q)){
  const jobsite=o=>/^(?:linkedin|indeed|glassdoor|handshake|ziprecruiter|monster|careerbuilder|simplyhired|dice|builtin|wellfound)(?:\.com)?$/i.test(String(o).replace(/\s+/g,''));
  // Exact source variants stay distinct from named/referral choices.
  // Workday tenants prefix boards ("Job Board - LinkedIn") and name the career
  // site by a parent brand ("RTX Corporate Career Site" at Raytheon).
  const bare=o=>String(o).replace(/^job board\s*[-–:]\s*/i,'').trim();
  // Greenhouse boards brand the LinkedIn variant: "LinkedIn (Freeform Job Post)" is his saved "LinkedIn post"
  // (Freeform 13281, where the fallback chose Handshake over the answer approved for Freeform 10199).
  const brand=norm(context.company??'');
  const canon=o=>{let s=norm(bare(o));if(brand)s=s.replace(new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'g'),' ');return s.replace(/\bjob\b/g,' ').replace(/\s+/g,' ').trim();};
  const linkedinPost=o=>/^linkedin post$/.test(canon(o));
  // GM names its site by initials: 'GM Careers Website' for General Motors (12142).
  const initials=String(context.company??'').split(/\s+/).filter(w=>/^[A-Z]/.test(w)).map(w=>w[0]).join('').toLowerCase();
  const ownInitials=o=>initials.length>=2&&new RegExp(`^${initials} career(?:s)? (?:web ?site|site|page|portal)$`).test(norm(o));
  const generic=o=>generic1(bare(o))||ownInitials(o)||/^[\w&.]+ corporate career(?:s)? (?:web ?site|site|page|portal)$/i.test(String(o).trim());
  const generic1=o=>/^linkedin (?:post|sponsored job\/ad)$/i.test(o)||linkedinPost(o)||jobsite(o)||/^(?:(?:the )?(?:company|employer|corporate)(?:['’]s)? (?:career(?:s)? )?(?:web ?site|site|page|portal)|career(?:s)? (?:web ?site|site|page|portal)|job search (?:web ?site|site|engine)|job (?:board|search)|other job board|via job search|jobagent|other|website|online|internet)$/i.test(o)||Boolean(context.company)&&['Website','Careers Page','Careers','Career Site'].some(s=>norm(o).replaceAll(' ','')===norm(`${context.company} ${s}`).replaceAll(' ',''));
  // Before a prompt opens, its missing options cannot invalidate an approved
  // generic source. Keep that leaf instead of navigating a default website.
  if(!options.length){
   const recorded=[...(context.approvedAnswers??[]),...Object.values(context.bank??{})]
    .find(a=>sourceQuestion(a.question??'')&&generic(a.answer??''));
   if(recorded)return {key:'routineSourceChoiceAllowed',value:recorded.answer,candidates:[recorded.answer],authoritative:true};
  }
  const allowed=options.filter(generic);
  const same=(o,p)=>norm(o)===norm(p)||norm(bare(o))===norm(p)||canon(o)===canon(p);
  const saved=[...(context.approvedAnswers??[]),...Object.values(context.bank??{})].find(a=>sourceQuestion(a.question??'')&&allowed.some(o=>same(o,a.answer)))?.answer;
  const actual=String(context.source??context.source_name??context.discoverySource??'');
  const preferred=[saved,actual,/linkedin/i.test(actual)?'LinkedIn':null,answers.hearAbout,answers.heardJobBoard].filter(v=>typeof v==='string');
  let value=preferred.map(p=>allowed.find(o=>norm(o)===norm(p))??allowed.find(o=>norm(bare(o))===norm(p))??allowed.find(o=>same(o,p))).find(Boolean);
  value??=allowed.find(o=>/company|employer|corporate/i.test(o))??allowed.find(o=>/career|website/i.test(o)&&!jobsite(o))??allowed.find(o=>/linkedin/i.test(o))??allowed.find(o=>/job|search/i.test(o))??allowed.find(jobsite)??allowed.find(o=>/^other$/i.test(o));
  if(!options.length)value=/linkedin/i.test(actual)?'LinkedIn':'Company Website';
  return value?{key:'routineSourceChoiceAllowed',value,candidates:[value],authoritative:true}:null;
 }
 if(answers.employerEmploymentDefault!=='No'||!employmentQuestion(q,context.company)||/^(?:describe|explain|provide|when|where|who|which|name)\b|\b(?:not|never)\b|n't/i.test(q))return null;
 const family=/family|relative|related|spouse|household/i.test(q);
 const current=/\b(?:currently|current|presently)\b/i.test(q)&&!/\b(?:former|previous|ever|past)\b/i.test(q);
 const contractor=/\bcontractor\b/i.test(q)&&!/\b(?:employee|employed|employment)\b/i.test(q);
 const employers=[...(context.history??context.workHistory??[]),...(answers.confirmedEmploymentCompanies??[])].filter(h=>(!current||h.current===true||Object.hasOwn(h,'to')&&h.to===null)&&(!contractor||h.contractor===true||/\bcontractor\b/i.test(`${h.title??''} ${h.description??''}`))).map(h=>norm(h.company));
 const company=norm(context.company);
 const self=!family||/\byou\s+(?:or|and)\b/i.test(q);
 const historyException=self&&company&&employers.some(c=>c===company);
 const exception=(answers.employerEmploymentExceptions??[]).find(e=>norm(e.company)===company&&(family?e.family===true:e.self===true));
 let value=historyException||exception?'Yes':'No';
 // Some employer dropdowns spell out the negative instead of offering No.
 // Map only an unambiguous self-history option bound to this exact employer.
 if(value==='No'&&!family&&company){
  const negatives=options.filter(o=>['i have not worked at','i have never worked at','i have not worked for','i have never worked for'].some(prefix=>norm(o)===`${prefix} ${company}`));
  if(negatives.length===1)value=negatives[0];
 }
 return {key:'employerEmploymentDefault',value,candidates:value==='Yes'||value==='No'?[value]:[value,'No'],authoritative:true};
}
