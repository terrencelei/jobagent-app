// Derived answers are limited to questions entailed by confirmed profile facts.
// Never treat an in-progress degree as a completed degree.
import {routineApplicationAnswer,routineQuestionNeedsReview} from './routine-application-policy.mjs';
export const US_STATE_NAMES=Object.fromEntries('AL:Alabama|AK:Alaska|AZ:Arizona|AR:Arkansas|CA:California|CO:Colorado|CT:Connecticut|DE:Delaware|DC:District of Columbia|FL:Florida|GA:Georgia|HI:Hawaii|ID:Idaho|IL:Illinois|IN:Indiana|IA:Iowa|KS:Kansas|KY:Kentucky|LA:Louisiana|ME:Maine|MD:Maryland|MA:Massachusetts|MI:Michigan|MN:Minnesota|MS:Mississippi|MO:Missouri|MT:Montana|NE:Nebraska|NV:Nevada|NH:New Hampshire|NJ:New Jersey|NM:New Mexico|NY:New York|NC:North Carolina|ND:North Dakota|OH:Ohio|OK:Oklahoma|OR:Oregon|PA:Pennsylvania|RI:Rhode Island|SC:South Carolina|SD:South Dakota|TN:Tennessee|TX:Texas|UT:Utah|VT:Vermont|VA:Virginia|WA:Washington|WV:West Virginia|WI:Wisconsin|WY:Wyoming'.split('|').map(s=>s.split(':')));
export function profileFact(label, answers = {}, context = {}) {
 // A select control offers {label,value} objects (Genentech Phenom 14640 flagged "Phone Device Type" because
 // the rules compared against "[object Object]"); rules below match on the offered labels.
 if(Array.isArray(context.options))context={...context,options:context.options.map(o=>o!==null&&typeof o==='object'?String(o.label??o.value??''):o)};
 if(routineQuestionNeedsReview(label))return null;
 const routine=routineApplicationAnswer(label,answers,context);if(routine)return routine;
 const q=String(label).trim().replace(/\s*\*\s*$/,'').replace(/\s*\(We comply with State and Federal child labor regulations\.\)\s*$/i,'');
 const contacts={ 'first name':'firstName', 'last name':'lastName', 'full name':'fullName', 'email':'email', 'email address':'email', 'contact email':'email', 'contact email address':'email', 'phone':'phone', 'phone number':'phone', 'home phone':'phone', 'mobile phone':'phone', 'mobile number':'phone', 'mobile phone number':'phone', 'cell phone':'phone', 'cell number':'phone', 'cell phone number':'phone', 'linkedin profile':'linkedin', 'linkedin':'linkedin', 'linkedin url':'linkedin', 'github':'github', 'github profile':'github', 'github url':'github', 'portfolio':'portfolio', 'portfolio url':'portfolio', 'portfolio link':'portfolio', 'portfolio website':'portfolio', 'online portfolio':'portfolio', 'website':'website', 'personal website':'website', 'website url':'website', 'personal site':'website' };
 // r717 (12981) exposes unlabeled inputs by name: home_phone, mobile_phone.
 const contact=contacts[q.toLowerCase().replace(/_/g,' ')];
 // A choice labelled Phone Number can actually be an SMS-consent question.
 // Its approved choice must not replace the saved number in a plain contact
 // input; conversely, never use a phone number as a consent choice.
 if(contact==='phone')return !context.options?.length&&answers.phone
  ?{key:'phone',value:answers.phone,authoritative:true}:null;
 if(contact&&answers[contact])return {key:contact,value:answers[contact]};
 // iRecruit (Piper 13354) splits a U.S. number into three boxes named
 // cellphone_1/2/3 (area code, prefix, line); the whole number overflowed each box.
 const split=/^(?:cell|mobile|home)[ _]?phone[ _]([123])$/i.exec(q);
 if(split&&!context.options?.length&&answers.phone){
  const digits=String(answers.phone).replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');
  if(digits.length===10)return {key:'phone',value:[digits.slice(0,3),digits.slice(3,6),digits.slice(6)][split[1]-1],authoritative:true};
 }
 if(/^(?:what is your |please (?:provide|enter) your )?earliest (?:available )?start date[.?]?$/i.test(q)){
  // The user supplied a distinct internship date. Use only an explicit role type;
  // a title alone or missing internship date cannot borrow full-time availability.
  const role=String(context.role_type??context.roleType??'').toUpperCase().replace(/[ -]/g,'_');
  const key=role==='INTERNSHIP'?'internshipAvailabilityStart':role==='FULL_TIME'?'earliestStartDate':null;
  const value=key&&answers[key];
  if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value)return {key,value,authoritative:true};
  return null;
 }
 // iRecruit (Piper 13354) "Type of work desired:" follows the posting's explicit role
 // type; a full-time posting is applied for as full-time work. Anything else stays a question.
 if(/^type of work desired:?$/i.test(q)&&context.options?.length){
  const role=String(context.role_type??context.roleType??'').toUpperCase().replace(/[ -]/g,'_');
  const offered=role==='FULL_TIME'&&context.options.find(o=>/^full[ -]?time$/i.test(String(o).trim()));
  return offered?{key:'roleType',value:offered,candidates:[offered]}:null;
 }
 // "Obtained or Pursuing" asks for the degree in progress, not the completed one.
 if(/highest.*(?:education|degree).*(?:completed|received|earned|obtained)|highest level of education you've received/i.test(q)&&!/\bpursu/i.test(q)&&answers.highestCompletedEducation){
  const value=answers.highestCompletedEducation;
  return {key:'highestCompletedEducation',value,candidates:[value,...(/high school/i.test(value)?['High School','High School Diploma or Equivalent','High School Diploma/GED','High School Graduate','High school or equivalent','High School Diploma OR Equivalent Certification']:[]),...(/bachelor/i.test(value)?['BA/BS/BSN',"Bachelor's Degree Or Equivalent","Bachelor's Level Degree",'Bachelors']:[])]};
 }
 for(const [pattern,key] of [
  [/^Have you ever been (?:terminated|fired|discharged)|^Have you ever.*asked to resign/i,'everTerminatedOrAskedToResign'],
  [/\bplans? to join the board of directors of a for-profit company/i,'forProfitBoardPlans'],
  [/^Are you currently serving on the board of directors of any for-profit company/i,'forProfitBoardMember'],
 ])if(pattern.test(q)&&['Yes','No'].includes(answers[key]))return {key,value:answers[key]};
 // Not having completed any bachelor's degree entails No, even if the field is qualified.
 if(/^Have you earned a Bachelor['’]s degree\b/i.test(q)&&/^(?:High School|GED|Associate)/i.test(answers.highestCompletedEducation??''))return {key:'highestCompletedEducation',value:'No'};
 if(/^pronouns$/i.test(q)&&answers.pronounsPlain){
  const value=answers.pronounsPlain;
  return {key:'pronounsPlain',value,candidates:[value,...(/^he\/him(?:\/his)?$/i.test(value)?['He/Him']:[]),...(/^she\/her(?:\/hers)?$/i.test(value)?['She/Her']:[]),...(/^they\/them(?:\/theirs)?$/i.test(value)?['They/Them']:[])]};
 }
 if(/^Please state your name and current date in the box below\s*\.?$/i.test(q)&&answers.fullName){
  const date=new Date(context.now??Date.now());
  if(Number.isFinite(date.getTime()))return {key:'fullName',value:`${answers.fullName}, ${date.toLocaleDateString('en-US')}`};
 }
 if(/^In which city and state are you located\??$/i.test(q)&&answers.city)return {key:'city',value:answers.city};
 if(/^(?:please (?:provide|enter|list) your |what is your )?(?:current |home |mailing )?(?:street )?address\??$/i.test(q)&&answers.addressLine1&&answers.addressCity&&answers.addressState&&answers.addressZip)return {key:'addressLine1',value:[answers.addressLine1,answers.addressLine2,answers.addressCity,`${answers.addressState} ${answers.addressZip}`].filter(Boolean).join(', ')};
 // A bare State select on the applicant's contact step (Cisco Phenom 12281) is his
 // address state; offer the full name only when the page lists it.
// Also asked as a question (Intuitive 12315/12316 SmartRecruiters: "What is your State or Province? *", a search box
 // whose options appear only after typing; he had to answer CA by hand, lesson 432): with no listed options, the full
 // state name is entered and the two-letter code is the fallback candidate.
 if(/^(?:what is your |please (?:enter|select|provide) your |your )?(?:current |home |residence |mailing )?(?:state|state\/province|state or province|province\/state)(?: of residence)?\s*\??\s*\*?$/i.test(q)&&/^[A-Z]{2}$/.test(answers.addressState??'')){
  const name=US_STATE_NAMES[answers.addressState];
  if(context.options?.length){
   const offered=context.options.find(o=>[answers.addressState,name].some(v=>v&&String(o).trim().toLowerCase()===v.toLowerCase()));
   if(offered)return {key:'addressState',value:offered,candidates:[offered]};
  }else if(name&&!/^(?:state|state\/province|state or province|province\/state)\s*\??$/i.test(q))return {key:'addressState',value:name,candidates:[name,answers.addressState]};
 }
 // Cisco 12281's contact step also requires the phone's device type and country code.
 // His saved number is the mobile Workday already reports; the code comes from phoneCountry.
 if(/^phone (?:device )?type$/i.test(q)&&answers.phone&&context.options?.length){
  const offered=context.options.find(o=>/^(?:mobile|mobile phone|cell|cell phone|mobile\/cell)$/i.test(String(o).trim()));
  if(offered)return {key:'phone',value:offered,candidates:[offered]};
 }
 if(/^(?:country phone code|phone country code|country code)$/i.test(q)&&context.options?.length){
  const m=/^(.*?)\s*\(?\+(\d+)\)?$/.exec(String(answers.phoneCountry??'').trim());
  const squash=v=>String(v).toLowerCase().replace(/[^a-z0-9+]+/g,'');
  const offered=m&&context.options.find(o=>{const om=/^(.*?)\s*\(?\+(\d+)\)?$/.exec(String(o).trim());return om&&om[2]===m[2]&&(squash(om[1])===squash(m[1])||squash(om[1])===squash(`${m[1]} of America`));});
  if(offered)return {key:'phoneCountry',value:offered,candidates:[offered,`+${m[2]}`,answers.phoneCountry]};
  // SmartRecruiters' Country code menu (Intuitive 12316, lesson 417) lists bare country names, no "+1"; the approved
  // "+1" and the saved "United States +1" are the same choice as the "United States" it offers.
  const named=m&&context.options.find(o=>squash(o)===squash(m[1])||squash(o)===squash(`${m[1]} of America`));
  if(named)return {key:'phoneCountry',value:named,candidates:[named,`+${m[2]}`,answers.phoneCountry]};
 }
 // No current employer (his instruction, 2026-10-23): "N/A" for the employer, "No" for currently employed.
 if(answers.noCurrentEmployer===true){
  if(/^Which company are you currently employed with\??$/i.test(q))return {key:'noCurrentEmployer',value:'N/A'};
  if(/^Are you currently employed\b/i.test(q)){
   const label=o=>String(o?.label??o);
   const no=(context.options??[]).map(label).find(o=>/^(?:no\b|not\b|i am not\b|i'?m not\b|unemployed\b|currently not\b)/i.test(o));
   if(no||!context.options?.length)return {key:'noCurrentEmployer',value:no??'No',candidates:[no??'No']};
  }
  // He has no current manager to notify: prefer a not-applicable option, else No.
  if(/^Have you (?:notified|told|informed) your (?:current )?(?:manager|supervisor|employer)\b/i.test(q)){
   const label=o=>String(o?.label??o);
   const opts=(context.options??[]).map(label);
   const pick=opts.find(o=>/^(?:n\/?a\b|not applicable\b)/i.test(o))??opts.find(o=>/^no\b/i.test(o));
   if(pick||!opts.length)return {key:'noCurrentEmployer',value:pick??'No',candidates:[pick??'No']};
  }
 }
 if(/^Which company are you currently employed with\??$/i.test(q)&&context.history?.some(h=>h.company==='IGEL Technology'&&h.to===null))return {key:'workHistory',value:'IGEL Technology'};
 if(/^Have you worked with us before\??$/i.test(q)&&/^(xAI|SpaceX|SpaceXAI)$/i.test(context.company??'')&&answers.spacexHistory==='I have never worked for SpaceX, SpaceXAI, xAI, X, or Twitter')return {key:'spacexHistory',value:answers.spacexHistory,candidates:[answers.spacexHistory,'No']};
 if(context.options?.length===2&&context.options.every(o=>['Yes','No'].includes(o))){
  for(const key of ['gender','eeoRace','veteranStatus'])if(answers[key]&&q.toLowerCase()===String(answers[key]).toLowerCase())return {key,value:'Yes'};
  if(/^Never held a clearance$/i.test(q)&&answers.heldSecurityClearance==='No')return {key:'heldSecurityClearance',value:'Yes'};
 }
 if(/^Vast Careers Page$/i.test(q)&&/^Vast(?: Space)?$/i.test(context.company??'')&&answers.vastHeardVia==='Vast Careers Page')return {key:'vastHeardVia',value:'Yes'};
 if(/how did you (hear|learn|find out|come to know) about|where did you (hear|learn) about/i.test(q)&&context.options?.length){
  const company=String(context.company??'');
  const sites=['Company Website','Company careers page / website',...['Careers','Careers Page','Website','Career Site'].map(s=>`${company} ${s}`)];
  // Employers write their own name without spaces ('FieldAI Website' for Field AI).
  const squash=v=>String(v).toLowerCase().replace(/[^a-z0-9]+/g,'');
  const offered=context.options.find(o=>sites.some(s=>squash(s)===squash(o)));
  if(offered&&/career|site/i.test(answers.hearAbout??''))return {key:'hearAbout',value:offered};
  const board=answers.heardJobBoard&&context.options.find(o=>/^(JobAgent|Other Job Board|Via Job Search|Other)$/i.test(o));
  if(board)return {key:'heardJobBoard',value:board};
 }
 if(/^(school|school or university|university)$/i.test(q)&&answers.school)return {key:'school',value:answers.school,candidates:[answers.school,...(answers.schoolAliases||[])]};
 if(/^(?:Highest (?:level of )?(?:education|education\/qualification) completed[.?]?|What is the highest level of education you have successfully completed\??)$/i.test(q)&&answers.highestCompletedEducation)return {key:'highestCompletedEducation',value:answers.highestCompletedEducation,candidates:[answers.highestCompletedEducation,"Bachelor's Degree Or Equivalent"].filter((v,i)=>i===0||/bachelor/i.test(answers.highestCompletedEducation))};
 // Export-control status wording differs by tenant (ASML: "Please indicate your current status.").
 if(/^(?:Identify|Please indicate) your current status[.?]?$/i.test(q)&&context.options?.some(o=>/^U\.?S\.? Citizen$/i.test(o))&&answers.citizenshipCountries?.includes('United States'))return {key:'citizenshipCountries',value:context.options.find(o=>/^U\.?S\.? Citizen$/i.test(o))};
 if(/^Which onsite location would you like to apply to\??$/i.test(q)&&answers.willingToRelocate==='Yes'&&context.options?.includes('No preference'))return {key:'willingToRelocate',value:'No preference'};
 if(/^I will need relocation to work on-site\.?$/i.test(q)&&answers.relocationAssistanceRequired==='Yes')return {key:'relocationAssistanceRequired',value:'Yes'};
 // Boeing Workday "Are you a veteran?": only his explicit not-a-veteran answer (selfIdVeteran) picks "I AM NOT A VETERAN"; "not a protected veteran" alone does not.
 if(/^Are you a veteran\?$/i.test(q)&&/^No\b.*not a veteran/i.test(answers.selfIdVeteran??'')){
  const none=context.options?.find(o=>/^I AM NOT A VETERAN\.?$/i.test(o));
  if(none)return {key:'selfIdVeteran',value:none,candidates:[none]};
 }
 if(/^Are you a protected veteran\?/i.test(q)&&/^I am not a protected veteran$/i.test(answers.veteranStatus??''))return {key:'veteranStatus',value:'Not a Veteran',candidates:['Not a Veteran','I am not a protected veteran','No']};
 if(/^Are you available to start within (\d+) days\??$/i.test(q)&&/^\d{4}-\d{2}-\d{2}$/.test(answers.earliestStartDate??'')){
  const now=new Date(context.now??Date.now()),start=new Date(answers.earliestStartDate+'T00:00:00Z');
  if(Number.isFinite(now.getTime())&&Number.isFinite(start.getTime()))return {key:'earliestStartDate',value:start<=new Date(now.getTime()+Number(q.match(/\d+/)[0])*86400000)?'Yes':'No'};
 }
 if(/^applicant\[earliest_start_date\]$/i.test(q)&&answers.earliestStartDate)return {key:'earliestStartDate',value:answers.earliestStartDate};
 if(/^When would you be available if an offer was accepted\?$/i.test(q)&&answers.earliestStartDate&&answers.graduationDate&&new Date(answers.earliestStartDate)>=new Date(answers.graduationDate))return {key:'earliestStartDate',value:'After Graduation (For current grads)'};
 if(/^If relocation assistance is provided, will you require this service\?$/i.test(q)&&['Yes','No'].includes(answers.relocationAssistanceRequired))return {key:'relocationAssistanceRequired',value:answers.relocationAssistanceRequired};
 if(/^The following statements are intended to preliminarily identify potential conflicts of interest that may arise as a result of your government service\./i.test(q)&&answers.governmentEmployment==='No')return {key:'governmentEmployment',value:'None of the above.'};
 if(/The following statements are intended to preliminarily identify potential restrictions that may arise as a result of your government service/i.test(q)&&answers.governmentEmployment==='No'){
  const none=context.options?.find(o=>/^None of the above[.!]?$/i.test(o));
  if(none)return {key:'governmentEmployment',value:none};
 }
 if(/Post-Government Employment Certification/i.test(q)&&answers.governmentEmployment==='No'&&answers.armedForcesService==='No'){
  const option=context.options?.find(o=>/^I have never been employed by the U\.S\. government or the U\.S\. Armed Forces\.$/i.test(o));
  if(option)return {key:'governmentEmployment',value:option};
 }
 for(const [pattern,key] of [
  [/^(?:\d+\.\s*)?Do you have experience using 3D CAD software\b/i,'mechanicalCadExperience'],
  [/^(?:\d+\.\s*)?Have you performed structural analyses\b/i,'structuralAnalysisExperience'],
  [/^(?:\d+\.\s*)?Have you contributed to any hands-on hardware project\b/i,'handsOnHardwareExperience'],
 ])if(pattern.test(q)&&['Yes','No'].includes(answers[key]))return {key,value:answers[key]};
 if(/^The Mechanical Team at Astranis hires mechanical engineers/i.test(q)&&answers.mechanicalSpecialization)return {key:'mechanicalSpecialization',value:answers.mechanicalSpecialization,candidates:[answers.mechanicalSpecialization,'B. Mechanisms design and analysis']};
 if(/^Are you currently employed\? If yes, may we speak to your present employer\?$/i.test(q)&&context.history?.some(h=>h.to===null&&h.company==='IGEL Technology')&&['Yes','No'].includes(answers.mayContactCurrentEmployer))return {key:'mayContactCurrentEmployer',value:answers.mayContactCurrentEmployer==='Yes'?'Currently employed, you may contact my current employer.':'Currently employed, do not contact my current employer.'};
 if(/^(?:What is your highest level of completed education\??|Indicate the highest level of education that you have completed:)$/i.test(q)&&typeof answers.highestCompletedEducation==='string')return {key:'highestCompletedEducation',value:answers.highestCompletedEducation,candidates:[answers.highestCompletedEducation,...(/bachelor/i.test(answers.highestCompletedEducation)?['BA/BS/BSN']:[])]};
 // iRecruit "Years Completed (numeric field)" on the in-progress degree row (Piper 13343): academic years
 // finished since the saved start, counted at each June, never past the expected graduation.
 if(/^Years Completed(?: \(numeric field\))?:?$/i.test(q)&&/^\d{4}$/.test(String(answers.eduStartYear??''))&&/^\d{2}\/\d{2}\/\d{4}$/.test(answers.graduationDate??'')){
  const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
  const startMonth=months.indexOf(String(answers.eduStartMonth??'').toLowerCase()),startYear=Number(answers.eduStartYear);
  const [gm,gd,gy]=answers.graduationDate.split('/').map(Number),now=new Date(context.now??Date.now());
  if(startMonth>=0&&new Date(Date.UTC(gy,gm-1,gd))>now){
   let years=0;for(let y=startYear+(startMonth>5?1:0);y<=gy;y++)if(new Date(Date.UTC(y,5,30))<=now)years++;
   return {key:'eduStartYear',value:String(years),candidates:[String(years)]};
  }
 }
 const age=q.match(/^Are you (?:over|at least) (\d{1,2}) years (?:of age|old)(?: or older)?\??$/i)??q.match(/^Are you (\d{1,2}) years (?:of age|old) or older\??$/i);
 if(age&&/^\d{4}-\d{2}-\d{2}$/.test(answers.dateOfBirth??'')){
  const birth=new Date(`${answers.dateOfBirth}T00:00:00Z`),now=new Date(context.now??Date.now());
  if(!Number.isFinite(birth.getTime())||!Number.isFinite(now.getTime())||birth>now||birth.toISOString().slice(0,10)!==answers.dateOfBirth)return null;
  const threshold=new Date(birth);threshold.setUTCFullYear(birth.getUTCFullYear()+Number(age[1]));
  const value=(/\bover\b/i.test(q)?now>threshold:now>=threshold)?'Yes':'No';
  return {key:'dateOfBirth',value,candidates:[value]};
 }
 if(/^What is your current (?:overall |cumulative )?(?:Grade Point Average \(GPA\)|GPA)\??$/i.test(q)){
  const value=answers.gpaExact??answers.gpaNumber;
  if(value!=null&&Number.isFinite(Number(value)))return {key:'gpaExact',value:String(value),candidates:[String(value),...(Number(value)>=3.5&&Number(value)<=4?['3.50 - 4.00 or higher']:[])]};
 }
 if(/^Do you accept that we use your information for other job openings\??$/i.test(q)&&answers.recruitmentEmailConsent==='Yes'&&answers.recruitmentMessageConsent==='Yes')return {key:'recruitmentEmailConsent',value:'Yes',candidates:['Yes']};
 if(/^Are you related to an employee of EY \(Ernst & Young\), including any predecessor firms or affiliates\??$/i.test(q)&&['Yes','No'].includes(answers.eyEmployeeRelative))return {key:'eyEmployeeRelative',value:answers.eyEmployeeRelative};
 return null;
}
