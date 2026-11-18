// User-stated answers, shared by platform adapters and CLI action validation.
import {settledAnswer} from './settled-facts.mjs';
import {profileFact} from './profile-facts.mjs';
import {connectionQuestion} from './answer-scope.mjs';
export function confirmedFactIsNewer(key,profile={},saved={}) {
 const confirmed=Date.parse(profile.confirmedFactSources?.[key]?.recordedAt);
 const approved=Date.parse(saved?.approvedAt);
 return Number.isFinite(confirmed)&&(!Number.isFinite(approved)||confirmed>approved);
}
export const PREFERENCE_FACTS = ['willingToRelocate','recruitmentEmailConsent','recruitmentMessageConsent','recruitmentSmsConsent','governmentEmployment','clearanceEligibleYesNo','heldSecurityClearance','currentSecurityClearance','citizenshipCountries','workAuthorizationCountries','employmentRestrictiveAgreements','governmentPersonalConnections','governmentContractorExperience','everDualCitizenship','usMilitaryJobTraining','militarySpouse','layoffRecall','hpePersonalConnections','boozAllenPersonalConnections','salaryExpectationRule','highestCompletedEducation','everDischarged','mayContactCurrentEmployer','relocationAssistanceRequired','mechanicalCadExperience','structuralAnalysisExperience','handsOnHardwareExperience','mechanicalSpecialization'];
export function internshipCompensationQuestion(label,job={}) {
 return job.role_type==='INTERNSHIP'&&/\b(?:salary|compensation|pay|hourly rate)\b/i.test(label)&&/\b(?:expect|desired|require|target|minimum|rate|salary)\w*/i.test(label);
}
export function salaryExpectation(answers={},job={}) {
 if(job.role_type==='INTERNSHIP')return null; // Full-time annual targets do not establish internship pay.
 const rule=answers.salaryExpectationRule;
 if(!rule)return null;
 const min=Number(job.salaryMin),max=Number(job.salaryMax);
 if(job.salaryMin!=null&&job.salaryMax!=null&&Number.isFinite(min)&&Number.isFinite(max)&&min<=max&&max>rule.minimum&&rule.minimum<=(min+max)/2)return String(rule.midpointOrLower);
 return String(rule.minimum);
}
PREFERENCE_FACTS.push('validDriversLicense','bachelorsDegreeYesNo','bachelorsDegreeYesNoNote','onsiteAlwaysOk','itarEligible','employerConnectionsDefault','armedForcesService','everTerminatedOrAskedToResign','forProfitBoardPlans','forProfitBoardMember','f1OptStatus','routineSourceChoiceAllowed','employerEmploymentDefault','confirmedEmploymentCompanies','employerEmploymentExceptions');
const normName=v=>String(v??'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
// "<Employer> engages <Firm> for auditing purposes ... have you or a close family member been employed by <Firm>?"
export function auditorEmploymentFirm(label){
 const q=String(label);
 const m=q.match(/\bengages?\s+(.+?)\s+(?:for|as)\s+(?:its\s+)?(?:independent\s+)?audit/i);
 if(!m||!/\b(?:you|your)\b.*\b(?:family|relative|spouse)\b.*\bemploy(?:ed|ment)?\b|\bemploy(?:ed|ment)?\b.*\b(?:family|relative|spouse)\b/i.test(q))return null;
 return m[1].replace(/,?\s+(?:LLP|LLC|Inc\.?|Ltd\.?)\s*$/i,'').trim()||null;
}
// A plain contact field ("Contact Email*", "Preferred Contact Phone") names his address, not a consent
// question; Virgin Galactic 13400 typed the email-consent "Yes" into its Contact Email box (lesson 401).
export const contactFieldLabel=label=>/^(?:(?:preferred|primary|secondary|alternate|alternative|personal|work|home|mobile|business|contact)\s+)*(?:e-?mail(?:\s+address)?|phone(?:\s+number)?|text(?:\s+number)?)\s*\*?\s*:?$/i.test(String(label??'').replace(/\s+/g,' ').trim());
export function preferenceAnswer(label, answers={}, context={}) {
 const q=String(label).trim().replace(/^\d+[.)]\s*/, '');
 // Leidos's Section 847 question ("Do you now, or did you at any time in the past 24 months, serve
 // as an official or employee of the DoD?") never says "government" and mentions contractors, so
 // the general government rule missed it, and the work-authorization rule read "National Defense
 // Authorization Act ... post-employment" as a right-to-work question (8383 submitted "Yes, I have served") and a wrong "Yes, I have served..." draft value was kept.
 // Never held a government job and never served in the armed forces settles it as No.
 if(/\b(?:an )?official or employee of the (?:DoD|Department of Defense)\b/i.test(q)&&/\bdo you now\b|\b(?:past|last) \d+ months\b/i.test(q)&&answers.governmentEmployment==='No'&&answers.armedForcesService==='No')
  return {key:'governmentEmployment',value:'No',authoritative:true,candidates:['No',/^No\b(?!.*\bbut\b)[ ,.\-–]*(?:I )?(?:have not|haven't|did not|do not|am not|have never)\b/i]};
 const derived=profileFact(q,answers,context);
 // Completed education is the user's corrected fact; old approved Bachelor's answers
 // cannot supersede it or the degree currently being pursued.
// No current employer (2026-10-23) also outranks old saved answers that named IGEL as his employer.
 if(derived)return ['highestCompletedEducation','noCurrentEmployer'].includes(derived.key)?{...derived,authoritative:true}:derived;
// Boeing's auditor question (11181, 2026-10-18): "Boeing engages Deloitte, LLP for auditing purposes
 // ... have you or a "close family member" been employed ... by Deloitte, LLP?" names a third party,
 // so the employer-history rule (which needs "us" or the employer) and connectionQuestion (which
 // never saw "employed") both passed, and the model step answered it on one run and flagged it on
 // the next. Self: the audit firm is absent from his confirmed employment; family: his saved
 // connections default. Both saved defaults must say No, and any "not/never" wording stays manual.
 const auditor=auditorEmploymentFirm(q);
 if(auditor&&answers.employerEmploymentDefault==='No'&&answers.employerConnectionsDefault==='No'&&!/\b(?:not|never)\b|n't/i.test(q)){
  const firm=normName(auditor).split(' ')[0];
  const employers=[...(context.history??context.workHistory??[]),...(answers.confirmedEmploymentCompanies??[])].map(h=>normName(h.company));
  const exception=employers.some(c=>c.split(' ').includes(firm))||(answers.employerEmploymentExceptions??[]).some(e=>normName(e.company).split(' ').includes(firm));
  if(!exception)return {key:'employerEmploymentDefault',value:'No',candidates:['No'],authoritative:true};
 }
 // iRecruit (Piper 13354): "If referred by a current employee please provide name here. If not please
 // type “None”" is a required text box whose own label dictates the answer when nobody referred him.
 // The connections rule below skips it ("not" wording), so it was left blank and Save/Next failed validation.
 // His saved No-connections default entails the literal word the label asks for, unless a bank answer says Yes.
 const typeNone=/\breferr(?:ed|al)\b/i.test(q)&&/\b(?:if not|if none|if no one|otherwise|if (?:not )?applicable)\b[^.]*?\b(?:type|enter|write|put|indicate|state)\s+["“']?(none|n\/?a)["”']?/i.exec(q);
 if(typeNone&&answers.employerConnectionsDefault==='No'&&!/^(?:describe|explain)\b/i.test(q)){
  const exception=Object.values(context.bank??{}).some(a=>connectionQuestion(a.question??'')&&/^(?:yes|true)\b/i.test(String(a.answer)));
  if(!exception)return {key:'employerConnectionsDefault',value:typeNone[1],candidates:[typeNone[1]],authoritative:true};
 }
 if(connectionQuestion(q)&&answers.employerConnectionsDefault==='No'&&!/^(?:describe|explain|provide|who|which|name)\b|\b(?:not|never|no connections)\b|n't/i.test(q)){
  const exception=Object.values(context.bank??{}).some(a=>connectionQuestion(a.question??'')&&/^(?:yes|true)\b/i.test(String(a.answer)));
  if(!exception)return {key:'employerConnectionsDefault',value:'No',candidates:['No','Not to my knowledge']};
 }
 if(/^Do you have a non-compete clause in a contract with your current or former employer that has not yet expired/i.test(q)&&answers.employmentRestrictiveAgreements==='No')return {key:'employmentRestrictiveAgreements',value:'No'};
 // Ashby (Apex 11041) labels the select just "Veteran Status" with no punctuation.
 if(/^Veteran Status(?:[:?*]|\s*$)/i.test(q)&&/^I am not a protected veteran$/i.test(answers.veteranStatus??''))return {key:'veteranStatus',value:answers.veteranStatus,candidates:[answers.veteranStatus,'I am not a Protected Veteran.']};
 // His saved self-identification answer; offered wordings differ slightly (Shield AI 10277, Relativity 12167).
 if(/^(?:disability status|do you have a disability)\s*[:?*]*\s*$/i.test(q)&&/^No, I do not have a disability\b/i.test(answers.disabilityStatus??''))
  return {key:'disabilityStatus',value:answers.disabilityStatus,candidates:[answers.disabilityStatus,/^No,? I (?:do not|don['’]t) have a disability/i]};
 if(/^May we contact your current employer\??\s*\*?$/i.test(q)&&['Yes','No'].includes(answers.mayContactCurrentEmployer))return {key:'mayContactCurrentEmployer',value:answers.mayContactCurrentEmployer};
 if(/^Were you ever discharged by any company\??\s*\*?$/i.test(q)&&['Yes','No'].includes(answers.everDischarged))return {key:'everDischarged',value:answers.everDischarged};
 if(/^Astranis complies with U\.S\. Government space technology export regulations, therefore will you state which of the following applies to you:/i.test(q)&&answers.citizenshipCountries?.includes('United States'))return {key:'citizenshipCountries',value:'I am a U.S. Citizen.',candidates:['I am a U.S. Citizen.']};
 if(/^Select YES to receive quick text messages from .+ regarding interview scheduling, status updates, and logistics for this role\./i.test(q)&&['Yes','No'].includes(answers.recruitmentSmsConsent))return {key:'recruitmentSmsConsent',value:answers.recruitmentSmsConsent};
 if(/^country\s*\*?$/i.test(q)&&answers.country)return {key:'country',value:answers.country,candidates:[answers.country,answers.phoneCountry,...(/^(US|USA|United States(?: of America)?)$/i.test(answers.country)?['United States of America','United States']:[])].filter(Boolean)};
 if(/^degree\s*\*?$/i.test(q)&&typeof answers.degree==='string')return {key:'degree',value:answers.degree,candidates:/bachelor/i.test(answers.degree)?[answers.degree,"Bachelor's Degree",'Bachelor of Science','Bachelors',"Bachelor's Level Degree",'BS','B.S.','BSc','B.Sc.','Bachelor of Science (BS)']:[answers.degree]};
 if(/^Clearance Eligibility\s*\*?$/i.test(q)&&['Yes','No'].includes(answers.clearanceEligibleYesNo))return {key:'clearanceEligibleYesNo',value:answers.clearanceEligibleYesNo};
 if(/^Do you presently hold an active U\.S\. security clearance, or are you eligible to obtain and maintain a U\.S\. security clearance\?/i.test(q)&&answers.currentSecurityClearance==='No'&&answers.clearanceEligibleYesNo==='Yes')return {key:'clearanceEligibleYesNo',value:'Yes, I am eligible for a U.S. security Clearance'};
 if(/\bprotected individuals?\b|\bU\.?S\.? Person\b/i.test(q)&&/export|Immigration and Naturalization|three criteria|three statuses/i.test(q)&&answers.citizenshipCountries?.includes('United States')&&!/\bnot|without|revoked|denied/i.test(q.split(/A [“"]?U\.?S\.? Person/i)[0])){
  const status=/which|any of the following/i.test(q);
  const citizen=['A United States citizen or national','A United States Citizen or National','US citizen or national','U.S. Citizen or National','U.S. citizen or national of the United States'];
  // "Are you currently a U.S. Person ...?" may still offer statuses with no Yes (True Anomaly 12996).
  return {key:'citizenshipCountries',value:status?citizen[0]:'Yes',candidates:status?citizen:['Yes',...citizen]};
 }
 if(/^discipline\s*\*?$/i.test(q)&&/mechanical/i.test(String(answers.discipline??answers.major??'')))return {key:'discipline',value:answers.discipline??answers.major,candidates:[answers.discipline,answers.major,'Mechanical Engineering','Engineering'].filter(Boolean)};

 if(/salary|compensation|pay expectation/i.test(q)&&/expect|desired|require|minimum|target/i.test(q)&&!/hour|month|week|GBP|EUR|CAD|AUD|£|€|current|previous|history/i.test(q.replace(/\bsalary\s+or\s+hourly\s+rate\b/i,'salary'))){
  // "desired salary or hourly rate" leaves the period to us; the saved rule is annual (Henny Penny 13120).
  const value=salaryExpectation(answers,context);
  if(value!==null)return {key:'minimumAnnualSalary',value};
 }
 // iRecruit puts the pay period in its own bare "per:" select after the pay expectation (Piper 13343).
 if(/^per\s*:?\s*\*?$/i.test(q)&&answers.salaryExpectationRule?.period==='annual'&&salaryExpectation(answers,context)!==null)return {key:'salaryExpectationRule',value:'Year',candidates:['Year','Yearly','Annually','Annual','Per Year']};
 // Confirmed by him on 2026-10-18: onsite or in-person work is never an issue, and he is ITAR
 // eligible. Questions that also impose long weekly hours stay with him.
 const willing=/\b(?:able|willing|comfortable|ok(?:ay)?|open|agree|available|can you|do you accept)\b/i;
 const longHours=[...q.matchAll(/\b(\d{2,3})\+?\s*(?:hours?|hrs?)\b/gi)].some(m=>Number(m[1])>40);
 if(answers.onsiteAlwaysOk==='Yes'&&/\b(?:on-?site|in[- ]person|in (?:the )?office|hybrid|in-office)\b/i.test(q)&&willing.test(q)&&!longHours&&!/\b(?:currently|previous(?:ly)?|describe|explain|why)\b/i.test(q))
  return {key:'onsiteAlwaysOk',value:'Yes',candidates:['Yes',/^Yes\b/i]};
 if(answers.itarEligible==='Yes'&&/\bITAR\b|export[- ]control/i.test(q)&&/\beligib|U\.?S\.? person|able to (?:access|comply|meet|work)|qualif|meet (?:the|these) requirement/i.test(q)&&!/\bwhich|select (?:the|all)|describe|explain|not eligible\b|^if other\b|provide details|N\/A if not applicable/i.test(q))
  return {key:'itarEligible',value:'Yes',candidates:['Yes',/^Yes\b/i]};
 // These are explicit answers, not assumptions derived from citizenship or work history.
 let confirmedKey;
 if(/\bHPE\b|Hewlett Packard Enterprise/i.test(q)&&/family|close personal/i.test(q)&&/government official/i.test(q)){
  if(!/^(do|are|have) you\b/i.test(q)||/\b(not|never|free of)\b|n't/i.test(q))return null;
  if(answers.hpePersonalConnections==='No'&&answers.governmentPersonalConnections==='No')return {key:'hpePersonalConnections',value:'No'};
  if(answers.hpePersonalConnections==='Yes'||answers.governmentPersonalConnections==='Yes')return {key:'hpePersonalConnections',value:'Yes'};
  return null;
 }
 if(!/\b(not|never|free of)\b|n't/i.test(q)&&!/^(describe|explain|provide|which|what)\b/i.test(q)){
  if(/non[- ]?compet|non[- ]?solicit|non[- ]?disclosure|\bNDA\b/i.test(q))confirmedKey='employmentRestrictiveAgreements';
  else if(/government|public institution|public body/i.test(q)&&/family|household|relative|close personal/i.test(q))confirmedKey='governmentPersonalConnections';
  else if(/government|public institution|public body/i.test(q)&&/contractor|consultant/i.test(q))confirmedKey='governmentContractorExperience';
  else if(/dual citizenship/i.test(q))confirmedKey='everDualCitizenship';
  else if(/military spouse/i.test(q))confirmedKey='militarySpouse';
  else if(/military/i.test(q)&&/job.related training/i.test(q))confirmedKey='usMilitaryJobTraining';
  else if(/layoff|laid off/i.test(q)&&/recall/i.test(q))confirmedKey='layoffRecall';
  else if(/family|household|relative|close personal/i.test(q)){
   if(/\bHPE\b|Hewlett Packard Enterprise/i.test(q))confirmedKey='hpePersonalConnections';
   else if(/Booz Allen/i.test(q))confirmedKey='boozAllenPersonalConnections';
  }
 }
 if(confirmedKey&&Object.hasOwn(answers,confirmedKey))return {key:confirmedKey,value:answers[confirmedKey]};
 // ApplicantPro (X-Bow 12727): "Please indicate if you agree to isolved Talent Acquisition's Applicant Communication
 // Policy." carries the SMS consent in its options ("Yes, I agree to be contacted by text messages" / "No, I do not agree
 // to receive text messages"), not in the question; his saved recruitmentSmsConsent answers it.
 const offered=(context.options??[]).map(o=>String(o?.label??o));
 if(/\b(?:agree|consent)\b.*\bcommunication policy\b/i.test(q)&&offered.some(o=>/\btext messages?\b|\bsms\b/i.test(o))&&['Yes','No'].includes(answers.recruitmentSmsConsent))return {key:'recruitmentSmsConsent',value:answers.recruitmentSmsConsent};
 // Rippling (Astra 13030): "Check Yes or No to indicate your agreement to receive text message updates from <employer>
 // regarding your job application ... Reply STOP to opt out" offers "Yes - I consent ..." / "No - I do not consent ...";
 // the "opt out" footer hid it from the generic consent rule and the blank group kept Apply disabled.
 if(/^Check Yes or No to indicate your agreement to receive text message updates from .+ regarding your job application\b/i.test(q)&&['Yes','No'].includes(answers.recruitmentSmsConsent)){
  const pick=offered.filter(o=>new RegExp(`^${answers.recruitmentSmsConsent}\\b`,'i').test(o.trim()));
  if(pick.length===1)return {key:'recruitmentSmsConsent',value:pick[0],candidates:[pick[0]]};
 }
 const settled=settledAnswer(q,answers,context);
 if(settled)return settled;
 let key;
 if(/\b(willing|able|prepared|open)\b.*\brelocat/i.test(q) && !/without|at your own|expense|assistance|sponsor/i.test(q))key='willingToRelocate';
 else if(!contactFieldLabel(q) && /\b(consent|agree|opt in|permission|receive|contact)\b/i.test(q) && /e-?mail|text messages?|\bsms\b|recruitment messages?|recruiting messages?/i.test(q) && !/do not|don't|decline|opt out|unsubscribe|withdraw|sell|share.*third.part/i.test(q))key=/e-?mail/i.test(q)?'recruitmentEmailConsent':'recruitmentMessageConsent';
 else if(/\bgovernment\b/i.test(q) && /\b(worked|employed|employee|employment|served|official)\b/i.test(q) && /\byou\b|your employment/i.test(q) && !/family|relative|spouse|partner|parent|child|contractor|customer/i.test(q))key='governmentEmployment';
 if(!key||!Object.hasOwn(answers,key))return null;
 // Never use Yes/No as a prose answer to an unrelated follow-up.
 if(/^(describe|explain|provide details|when|where|which|what level)/i.test(q))return null;
 const value=answers[key];
 const candidates=key==='governmentEmployment'&&value==='No'?[value,/^I have never been employed by (?:the )?(?:U\.?S\.?|United States) Federal Government\.?$/i]:[value];
 return {key,value,candidates};
}
