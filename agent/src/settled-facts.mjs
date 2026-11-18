// Resolve equivalent questions from confirmed facts before asking the applicant.
// Country-specific facts are usable only when the question or job identifies the country.
const us = /\b(?:united states(?: of america)?|u\.?s\.?a?\.?)\b/i;
const negative = /\b(?:not|never|unable|ineligible|without)\b|n't\b/i;
const yesNo = value => value === true || value === 'Yes' ? 'Yes' : value === false || value === 'No' ? 'No' : null;
const countryNames = new Intl.DisplayNames(['en'], {type:'region'});
const foreignCountries = [];
for(let a=65;a<=90;a++)for(let b=65;b<=90;b++){
 const code=String.fromCharCode(a,b),name=countryNames.of(code);
 if(code!=='US'&&name!==code&&name.length>3)foreignCountries.push(name.toLowerCase());
}
function usScope(label, context={}) {
 const text=label.toLowerCase();
 if(foreignCountries.some(name=>new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'i').test(text))||/\b(?:uk|u\.k\.|eu|non[- ]us|outside|other countries)\b/i.test(label))return false;
 if(us.test(label))return true;
 // An explicit unknown jurisdiction must not inherit the job's country.
 if(/\bin\s+(?!the country\b|this country\b|the country of\b)[A-Z]/.test(label))return false;
 const location=String(context.country||context.location||'');
 return us.test(location)||/^Puerto Rico\b/i.test(location)||/,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)(?:\s+\d{5})?(?:\s+[–-]\s+[\w .&/()]+)?\s*$/.test(location)||/,\s*(?:California|Pennsylvania|North Carolina|South Carolina|Maryland|Virginia|Iowa|Texas|Washington|Massachusetts|Colorado|Ohio|Florida|Georgia|Michigan|Illinois|Arizona|Oregon|New York)\s*$/i.test(location);
}
function result(key,value,candidates=[value]) {return value===null||value===undefined?null:{key,value,candidates};}
export function settledAnswer(label, answers={}, context={}) {
 let q=String(label).trim();
 // Notes about evidence or a clearance are not additional eligibility questions.
 q=q.split(/\s+NOTE:\s*/i)[0];
 if(/^Do you (?:hold|have)\b.*citizenship.*\bother than (?:the )?(?:US|U\.?S\.?|United States)\s*[?*]*$/i.test(q)){
  if(!answers.citizenshipCountries?.length)return null;
  return result('citizenshipCountries',answers.citizenshipCountries.some(c=>!/^United States(?: of America)?$/i.test(c))?'Yes':'No');
 }
 if(/^(?:If your position requires a security clearance,?\s*)?(?:are|will) you (?:be )?able to provide proof of U\.?S\.? Citizenship\??\s*\*?$/i.test(q)&&answers.citizenshipCountries?.includes('United States'))return result('citizenshipCountries','Yes');
 // Lever export-control follow-up (CFS 11832): a U.S. citizen answers Yes above, so the country field takes N/A.
 if(/^If you answered ["“]No["”] to the above, please provide the country or countries of which you are a current citizen.*If you answered ["“]Yes,?["”],? please enter N\/A\W*$/i.test(q)&&answers.citizenshipCountries?.includes('United States'))return result('citizenshipCountries','N/A',['N/A']);
 // Greenhouse ITAR "If other, please provide details ... Answer N/A if not applicable" (True Anomaly 12996):
 // a U.S. citizen answered the status question above with U.S. citizen, so the explanation takes N/A, never "Yes".
 if(/^If other,? please provide details\b.*\b(?:ITAR|export[- ]control)\b.*\bN\/A if not applicable\W*$/i.test(q)&&answers.citizenshipCountries?.includes('United States'))return result('citizenshipCountries','N/A',['N/A']);
 // Rippling source follow-ups "If 3rd Party Recruiting Agency / If "Other" above, please specify. If not
 // applicable, type n/a" (Astra 13030): his saved careers-site source is neither, so the form asks for n/a.
 if(/^If (?:(?:a )?3rd[- ]Party Recruiting Agency|["“]?Other["”]? above),? please specify\.? If not applicable,? type n\/a\W*$/i.test(q)&&/career|site/i.test(answers.hearAbout??'')&&!/agency|recruit|other/i.test(answers.hearAbout))return result('hearAbout','n/a',['n/a','N/A']);
 if(/^Please note that this role is not eligible for work authorization sponsorship\. Are you/i.test(q))q=q.slice(q.indexOf('Are you'));
 // Definitions after the actual sponsorship question do not negate it.
 if(/\b(?:require|need)\b.*\b(?:sponsorship|visa)\b/i.test(q))q=q.split(/\s+For (?:purposes of this question|the purposes of this question),?/i)[0];
 // OPT/F-1 eligibility does not apply to the user's confirmed U.S. citizenship.
 // Match only this immigration context: a STEM degree alone and generic opt-ins
 // are different questions. Never invent an offered answer or a completed degree.
 // Definitions and examples do not change the claim asked by the main question.
 const optFocus=q.split(/\?|\b(?:for example|including|such as)\b/i)[0].replace(/\([^)]*\)/g,' ');
 const optQuestion=/\bOPT\b/.test(optFocus)||/optional practical training|\bSTEM[- ]OPT\b|\bF[-– ]?1\b|\bopt (?:extension|authorization|status|program)\b/i.test(optFocus);
 const sponsorshipQuestion=/\b(?:require|need)\b.*\b(?:sponsorship|visa)\b/i.test(optFocus);
 if(optQuestion&&!sponsorshipQuestion&&!/\b(?:citizen|citizenship|permanent resident|green card)\b/i.test(q)&&answers.citizenshipCountries?.includes('United States')){
  const offered=context.options?.map(o=>typeof o==='string'?o:o.label).filter(Boolean)??[];
  const na=offered.filter(o=>/^(?:N\s*\/\s*A|Not applicable|Does not apply)(?:\s*[-–:]\s*(?:I am (?:a |an )?)?(?:U\.?S\.? citizen|United States citizen))?\s*[.!]?$/i.test(o));
  return na.length===1?result('f1OptStatus',na[0],[na[0]]):null;
 }
 // Generic jurisdiction guidance describes both U.S. and foreign postings. Resolve
 // the actual question against this posting's location, not the hypothetical branch.
 if(/in the country where this role is (based|located)/i.test(q)&&/If this role is located in the United States/i.test(q)&&/If this role is not located in the United States/i.test(q))q=q.split(/\s*If this role is located in the United States/i)[0];
 if(/Can you confirm that you are currently (?:a )?(?:US|U\.?S\.?) Citizen\??\s*\*?$/i.test(q))q='Are you a U.S. citizen?';
 if(/^(describe|explain|provide details|when|where)\b/i.test(q))return null;
 if(/\b(?:spouse|family|parents?|partner|revoked|denied|suspended)\b/i.test(q)||/\b(?:and|or)\b.*\b(?:willing|relocate|travel|polygraph|renounce)\b/i.test(q))return null;
 if(/\bclearance\b/i.test(q)){
  if(negative.test(q)||/\b(?:and|or)\b.*\b(?:relocate|travel|polygraph|citizen)\b/i.test(q))return null;
  if(/\b(?:eligible|able|ability)\b.*\b(?:obtain|receive|hold|qualify|secure)\b/i.test(q)){
   // General eligibility does not establish eligibility for a particular level or foreign clearance.
   if(/\b(?:top secret|secret|ts|sci|polygraph|dv|sc)\b/i.test(q)||!usScope(q,{country:'United States'}))return null;
   if(!/\b(?:obtain|receive|hold|secure|qualify for)\s+(?:an?\s+)?(?:(?:u\.?s\.?|united states)\s+)?(?:security\s+)?clearance\b/i.test(q))return null;
   return result('clearanceEligibleYesNo',yesNo(answers.clearanceEligibleYesNo));
  }
  const past=/\b(?:ever|previously|past|formerly)\b/i.test(q);
  if(!past&&!/\b(?:level|type|status)\b|\b(?:have|hold|possess)\b.*\bclearance\b|^(?:active )?security clearance(?:\(s\)|s)?\s*[?*:]*$/i.test(q))return null;
  const key=past?'heldSecurityClearance':'currentSecurityClearance';
  const value=yesNo(answers[key]??(answers.heldSecurityClearance==='No'?'No':undefined));
  if(value==='No')return result(key,/\b(?:level|type|status)\b|^(?:active )?security clearance(?:\(s\)|s)?\s*[?*:]*$/i.test(q)?'None':'No',['No','None','No clearance','None / Not applicable','Not applicable','N/A',...(answers.heldSecurityClearance==='No'?['Never held a clearance','I have never held a security clearance','N/A - have never held U.S. security clearance']:[]),
   // "No I have no US Security Clearance or it was active longer than 2 years ago" (Sierra Nevada).
   // "I have never held a DoD security clearance" (Karman 16537) and "Never held a DoD security
   // clearance" (Karman 16669): same Greenhouse multi-select, with and without "I have".
   /^(?:I have )?never (?:held|had) (?:a|an|any)\b.*\bclearance\b/i,
   /^No\b[ ,.\-–]*(?:I )?(?:have|hold|do not (?:have|hold)) no\b.*\bclearance\b/i,/^No[ ,.\-–]+I (?:do not|don't) (?:currently )?(?:have|hold) (?:a|an|any) (?:active |US |U\.S\. )*(?:security )?clearance\b/i]);
  if(value==='Yes'&&/^(?:do|have|are)\b/i.test(q)&&!/\b(?:level|type|top secret|secret|ts|sci)\b/i.test(q))return result(key,value);
  return null;
 }
 // A statute's name ("National Defense Authorization Act") is not a work-authorization question.
 q=q.replace(/\b(?:[A-Z][A-Za-z]*\s+)*Authori[sz]ation Act\b/g,'Act');
 if(!usScope(q,context)||negative.test(q.replace(/without (?:requiring )?(?:employer )?(?:visa\/permit |visa |employment )?(?:the need for )?sponsorship/ig,'')))return null;
 if(/^Do you possess a valid (?:work|residency) permit in the country for which the position resides\??\s*\*?$/i.test(q)&&answers.citizenshipCountries?.includes('United States'))return result('citizenshipCountries','Not Applicable',['Not Applicable','Not applicable','N/A']);
 if(/\b(?:citizen|citizenship|national of)\b/i.test(q)){
  if(/\b(?:dual|sole|only|exclusively|birth|born|naturalized|renounce|parents?|and)\b|other than/i.test(q))return null;
  if(!answers.citizenshipCountries?.some(c=>/^United States$/i.test(c)))return null;
  const value=/\b(?:status|select|what|which)\b/i.test(q)?'U.S. Citizen':'Yes';
  return result('citizenshipCountries',value,[value,'Yes','Yes, I am currently a US Citizen','I am a U.S. Citizen.','U.S. Citizen','US Citizen','United States citizen','U.S. Citizen or National','(a) U.S. citizen or national of the United States']);
 }
 if(/\b(?:authori[sz](?:ed|ation)|eligible|right|permission|legally able)\b.*\b(?:work|employment)\b/i.test(q)&&/without.*sponsorship/i.test(q)){
  if(!answers.workAuthorizationCountries?.includes('United States')||yesNo(answers.requiresSponsorship??answers.sponsorshipYesNo)!=='No')return null;
  return result('workAuthorizationCountries','Yes');
 }
 if(/\b(?:sponsorship|visa)\b/i.test(q)&&/\b(?:require|requiring|need)\b/i.test(q)){
  const value=yesNo(answers.requiresSponsorship??answers.sponsorshipYesNo);
  return result('requiresSponsorship',value,[value,...(value==='No'&&answers.citizenshipCountries?.includes('United States')?[/^N\/A\s*[–-]\s*I am a US citizen, US national, legal permanent resident \(Green Card holder\), granted refugee or granted asylee status\.?$/i]:[])]);
 }
 if(/\b(?:authori[sz](?:ed|ation)|eligible|right|permission|legally able)\b.*\b(?:work|employment)\b/i.test(q)){
  if(!answers.workAuthorizationCountries?.some(c=>/^United States$/i.test(c)))return null;
  if(/without.*sponsorship/i.test(q)&&yesNo(answers.requiresSponsorship??answers.sponsorshipYesNo)!=='No')return null;
  return result('workAuthorizationCountries','Yes',['Yes','I am authorized to work in the United States for any employer']);
 }
 return null;
}
const normalized=value=>String(value).toLowerCase().replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/^\s*(?:\([a-z0-9]+\)|\d+[).])\s*/,'').replace(/[.*]/g,'').replace(/\s+/g,' ').trim();
export function equivalentOption(label,value,options,answers={},context={}) {
 const exact=options.filter(o=>normalized(o)===normalized(value));
 if(exact.length===1)return exact[0];
 // A generic company-site source ("Company Website", "Careers site") is the employer's own
 // named site option, as Anduril offers "Anduril Website" (4662).
 if(/how did you (hear|learn|find out) about|where did you (hear|learn) about/i.test(label)&&context.company&&/^(?:(?:the )?(?:company|employer|corporate)(?:['’]s)? )?(?:careers? )?(?:web ?site|site|page|portal)$/i.test(String(value).trim())){
  const own=options.filter(o=>['Website','Careers Page','Careers','Career Site','Careers Website','Careers Site'].some(s=>normalized(o)===normalized(`${context.company} ${s}`)));
  if(own.length===1)return own[0];
 }
 if(/how did you (hear|learn|find out) about|where did you (hear|learn) about/i.test(label)&&/career|site/i.test(String(value))&&/career|site/i.test(answers.hearAbout??'')){
  const sites=options.filter(o=>/^(Company Website|Company careers page \/ website)$/i.test(o)||normalized(o)===normalized(`${context.company} Careers Page`));
  if(sites.length===1)return sites[0];
  if(!sites.length&&answers.heardJobBoard){const board=options.filter(o=>/^(JobAgent|Other Job Board|Via Job Search)$/i.test(o));if(board.length===1)return board[0];}
 }
 if(['Yes','No'].includes(value)&&/^Use of AI (?:to Assess my Application|for Future AI Matching)/i.test(label)){
  const matches=options.filter(o=>value==='Yes'?/I consent to the use of AI tools/i.test(o)&&!/(?:opt out|do not consent)/i.test(o):/I consent to the processing of my personal information/i.test(o)&&/opt out of the use of AI tools/i.test(o));
  if(matches.length===1)return matches[0];
 }
 if(['Yes','No'].includes(value)&&/^Do you consent to receive additional email communications/i.test(label)&&/marketing communications/i.test(label)){
  const matches=options.filter(o=>value==='Yes'?/^I consent to receive additional email communications/i.test(o):/^I do not consent to receive additional email communications/i.test(o));
  if(matches.length===1)return matches[0];
 }
 // ApplicantPro (X-Bow 12727) words the Communication Policy choices "Yes, I agree to be contacted by text messages" /
 // "No, I do not agree to receive text messages"; the text-message subject may sit in the options rather than the label.
 if(['Yes','No'].includes(value)&&/\b(?:consent|agree)\b/i.test(label)&&(/contacted|e-?mail|text|SMS/i.test(label)||options.some(o=>/\btext messages?\b|\bSMS\b/i.test(o)))){
  const matches=options.filter(o=>value==='Yes'?/^Yes[ ,]+I (?:consent|agree)\b/i.test(o)&&!/\b(?:do not|don't)\b/i.test(o):/^No[ ,]+I do not (?:consent|agree)\b/i.test(o));
  if(matches.length===1)return matches[0];
 }
 let aliases=[];
 if(/^country\s*\*?$/i.test(label)){
  aliases=[answers.country,answers.phoneCountry];
  const usOption=/^united states(?: of america)?(?:\s*\(?\+1\)?)?$/i;
  if(aliases.some(a=>usOption.test(String(a??'')))&&usOption.test(String(value))){const matched=options.filter(o=>usOption.test(o));if(matched.length===1)return matched[0];}
 }
 else if(/^(?:location \(city\)|city)\s*\*?$/i.test(label))aliases=[answers.city,answers.citySearch];
 else if(/^(school|school or university|university)\s*\*?$/i.test(label))aliases=[answers.school,...(answers.schoolAliases||[])];
 else if(/^discipline\s*\*?$/i.test(label)){aliases=[answers.discipline,answers.major];if(aliases.some(a=>/mechanical/i.test(String(a))))aliases.push('Engineering');}
 else if(/^(?:please identify your )?race\s*\*?$/i.test(label)){
  aliases=[answers.race,answers.eeoRace];
  if(aliases.some(a=>/^Asian \(Not Hispanic or Latino\)$/i.test(a??'')))aliases.push('Asian');
 }
 aliases=aliases.filter(Boolean);
 if(aliases.some(a=>normalized(a)===normalized(value))){
  const matches=options.filter(o=>aliases.some(a=>normalized(a)===normalized(o)));
  if(matches.length===1)return matches[0];
 }
 // Callers may pass derived candidate aliases (education or protected-person status).
 const settled=context.confirmedAnswer??settledAnswer(label,answers,context);
 // Never reinterpret a manually supplied answer that contradicts the profile.
 const candidates=settled?.candidates??(settled?[settled.value]:[]);
 if(!settled||!candidates.some(c=>normalized(c)===normalized(value)))return null;
 const matches=options.filter(o=>candidates.some(c=>c instanceof RegExp?c.test(o):normalized(c)===normalized(o)));
 return matches.length===1?matches[0]:null;
}
