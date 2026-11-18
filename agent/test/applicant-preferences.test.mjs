import test from 'node:test';
import assert from 'node:assert/strict';
import {preferenceAnswer,salaryExpectation} from '../src/applicant-preferences.mjs';
import {availableFacts,approvedValue} from '../src/dashboard-worker.mjs';
import {resolveQuestion} from '../src/workday.mjs';
const answers={willingToRelocate:'Yes',recruitmentEmailConsent:'Yes',recruitmentMessageConsent:'Yes',governmentEmployment:'No',clearanceEligibleYesNo:'Yes',heldSecurityClearance:'No',currentSecurityClearance:'No',citizenshipCountries:['United States'],workAuthorizationCountries:['United States']};
test('newly confirmed answers are reusable without borrowing another employer relationship',()=>{
 const facts={employmentRestrictiveAgreements:'No',governmentPersonalConnections:'No',governmentContractorExperience:'No',everDualCitizenship:'No',usMilitaryJobTraining:'No',militarySpouse:'No',layoffRecall:'No',hpePersonalConnections:'No',boozAllenPersonalConnections:'No'};
 for(const q of ['Have you signed a non-disclosure agreement?','Have any relatives worked for government?','Have you worked as a government contractor?','Have you ever held dual citizenship?','Are you a current or former military spouse?','Have you had job-related training in the U.S. Military?',"Are you on layoff status and subject to recall?",'Do you have relatives at HPE?','Does a family member work for Booz Allen?'])assert.equal(preferenceAnswer(q,facts)?.value,'No',q);
 assert.equal(preferenceAnswer('Does a family member work for Apple?',facts),null);
 assert.equal(preferenceAnswer('Are you free of non-compete agreements?',facts),null);
});
// The rule's range mechanics, with an illustrative minimum below the cap. His own rule since lesson 275 (2026-10-21)
// is 110000 in every case (minimum = midpointOrLower = 110000), checked at the end of this test.
test('salary expectation rule: range mechanics and his flat 110000',()=>{
 const facts={salaryExpectationRule:{minimum:100000,midpointOrLower:110000}};
 for(const [salaryMin,salaryMax,want] of [[80000,100000,'100000'],[80000,120000,'110000'],[100000,140000,'110000'],[90000,105000,'100000'],[null,null,'100000']]){
  const job={salaryMin,salaryMax};assert.equal(salaryExpectation(facts,job),want);
  assert.equal(preferenceAnswer('What is your desired annual salary?',facts,job).value,want);
  assert.equal(approvedValue({}, {label:'What are your salary requirements?',type:'text'}, {answers:facts}, {'what are your salary requirements?':{answer:'100000'}},new Map(),'Fixture',job),want);
  assert.equal(resolveQuestion('What is your desired annual salary?',{}, {...job,answers:facts}).candidates[0],want);
 }
 for(const q of ['What are your salary expectations in GBP?','What is your desired hourly salary?','What is your current salary?'])assert.equal(preferenceAnswer(q,facts),null);
 const his={salaryExpectationRule:{minimum:110000,midpointOrLower:110000}};
 for(const job of [{salaryMin:80000,salaryMax:100000},{salaryMin:120000,salaryMax:160000},{salaryMin:null,salaryMax:null}])assert.equal(salaryExpectation(his,job),'110000');
});
for(const [q,want] of [['Are you willing to relocate?','Yes'],['Do you consent to recruitment emails?','Yes'],['May we contact you with text messages?','Yes'],['Have you ever been employed by the government?','No'],['Are you eligible to obtain security clearance?','Yes'],['Have you ever held a security clearance?','No'],['Do you currently hold a security clearance?','No']])test(q,()=>{
 assert.equal(preferenceAnswer(q,answers).value,want);
 assert.equal(resolveQuestion(q,{}, {answers}).candidates[0],want);
 assert.equal(approvedValue({fact:'unknown'},{label:q,type:'select-one'},{answers},{},new Map()),want);
});
test('unconfirmed related claims do not borrow preferences',()=>{
 for(const q of ['Are you willing to relocate at your own expense?','Has your spouse worked in government?','Have you worked as a government contractor?','Are you eligible to obtain Top Secret clearance?','Do you decline to consent to emails?','Are you authorized to work in Canada?'])assert.equal(preferenceAnswer(q,answers),null,q);
 assert.equal(preferenceAnswer('Are you willing to relocate?',{}),null);
});
test('CLI sees saved preferences and their jurisdiction',()=>{
 const facts=availableFacts({answers},'Fixture');
 assert.equal(facts.governmentEmployment,'No');
 assert.deepEqual(facts.citizenshipCountries,['United States']);
 assert.deepEqual(facts.workAuthorizationCountries,['United States']);
});

test('Leidos Section 847 DoD question is No when he never held a government job or served',()=>{
 const label='2. Section 847 of the National Defense Authorization Act for Fiscal Year 2008 (Pub. L. No. 110-181) requires certain current and former Department of Defense (DoD) officials or employees, including any agency, command or organization of the DoD, as well as the military departments, to seek and obtain a written ethics opinion regarding the applicability of post-employment restrictions to activities they may undertake on behalf of a contractor. Do you now, or did you at any time in the past 24 months, serve as an official or employee of the DoD? For more information, see National Defense Authorization Action (Section 847)';
 const facts={...answers,armedForcesService:'No'};
 const known=resolveQuestion(label,{},{answers:facts});
 assert.equal(known.candidates[0],'No');
 const pattern=known.candidates.find(c=>c instanceof RegExp);
 assert.ok(pattern.test('No, I have not served in the last 24 months as an official or employee of the DoD.'));
 for(const o of ['Yes, I have served in the last 24 months as an official or employee of the DoD.','No, but I served 3 years ago'])assert.ok(!pattern.test(o),o);
 assert.equal(preferenceAnswer(label,{...facts,armedForcesService:undefined}),null);
 assert.equal(preferenceAnswer(label,{...facts,governmentEmployment:'Yes'}),null);
});

test('a saved "No" disability answer fills Disability Status selects (Relativity 12167)',async()=>{
 const {resolveKnownQuestion}=await import('../src/dashboard-worker.mjs');
 const answers={disabilityStatus:'No, I do not have a disability and have not had one in the past'};
 const options=['Yes, I have a disability, or have had one in the past','No, I do not have a disability and have not had one in the past','I do not want to answer'];
 for(const label of ['Disability Status','Disability status*','Do you have a disability?'])
  assert.equal(resolveKnownQuestion({question:{label,type:'select',options},profile:{answers},bank:{},job:{company:'X'}}).value,options[1],label);
 assert.equal(resolveKnownQuestion({question:{label:'Disability Status',type:'select',options},profile:{answers:{}},bank:{},job:{company:'X'}}).resolved,false);
 assert.equal(resolveKnownQuestion({question:{label:'Describe any disability accommodations you need',type:'textarea'},profile:{answers},bank:{},job:{company:'X'}}).resolved,false);
});

test('his confirmed onsite, ITAR and full-time compensation answers fill routine questions',async()=>{
 const {resolveKnownQuestion}=await import('../src/dashboard-worker.mjs');
 const answers={onsiteAlwaysOk:'Yes',itarEligible:'Yes',salaryExpectationRule:{minimum:110000,midpointOrLower:110000}};
 const ask=(label,job={role_type:'FULL_TIME'},options=['Yes','No'])=>resolveKnownQuestion({question:{label,type:'select',options},profile:{answers},bank:{},job:{company:'X',...job}});
 assert.equal(ask('Are you able to work a hybrid (on-site/off-site) schedule in Brea, CA?').value,'Yes');
 assert.equal(ask('Are you ITAR eligible?').value,'Yes');
 assert.equal(resolveKnownQuestion({question:{label:'What is your expected compensation for this role?',type:'text'},profile:{answers},bank:{},job:{company:'X',role_type:'FULL_TIME'}}).value,'110000');
 // Internship pay, long-hours commitments and questions about current status stay with him.
 assert.equal(resolveKnownQuestion({question:{label:'What is your expected compensation for this role?',type:'text'},profile:{answers},bank:{},job:{company:'X',role_type:'INTERNSHIP'}}).resolved,false);
 assert.equal(ask('This role is onsite 5 days a week and requires 55 hours per week. Are you comfortable with this?').resolved,false);
 assert.equal(ask('Are you currently working onsite?').resolved,false);
 assert.equal(ask('Are you able to work onsite?',{role_type:'FULL_TIME'}).resolved,true);
});

test('a bare Ashby "Veteran Status" select uses his saved veteran answer (Apex 11041)', () => {
 const facts={veteranStatus:'I am not a protected veteran'};
 for(const q of ['Veteran Status','Veteran Status*','Veteran Status: please indicate'])assert.equal(preferenceAnswer(q,facts)?.value,'I am not a protected veteran',q);
 assert.equal(preferenceAnswer('Veteran Status details',facts),null);
 assert.equal(preferenceAnswer('Veteran Status',{}),null);
});
test("Boeing's auditor self/family employment question is No from the saved employer defaults (11181)",()=>{
 const label='5) Boeing engages Deloitte, LLP for auditing purposes. This question identifies personal and family connections to Deloitte, LLP. At any time within the last four (4) years from today\'s date, have you or a "close family member" been employed (full-time or part-time) by Deloitte, LLP? A "close family member" includes a person\'s spouse, spousal equivalent, parent, dependent, nondependent child or sibling. "Deloitte, LLP" includes Deloitte LLP, Deloitte and Touche LLP, Deloitte Tax LLP, Deloitte FAS LLP, and Deloitte Consulting LLP, as well as any affiliates of such entities.';
 const facts={employerEmploymentDefault:'No',employerConnectionsDefault:'No',confirmedEmploymentCompanies:[{company:'Applied Materials',current:false},{company:'Example State University',current:true}]};
 const got=preferenceAnswer(label,facts,{company:'Boeing',workHistory:[{company:'Northrop Grumman'}]});
 assert.equal(got?.value,'No'); assert.equal(got?.authoritative,true);
 // A confirmed Deloitte job or a family exception keeps it on the approval card.
 assert.equal(preferenceAnswer(label,{...facts,confirmedEmploymentCompanies:[{company:'Deloitte Consulting LLP',current:false}]},{company:'Boeing'}),null);
 assert.equal(preferenceAnswer(label,{...facts,employerEmploymentExceptions:[{company:'Deloitte',family:true}]},{company:'Boeing'}),null);
 // Without both saved defaults, or with negated wording, nothing is assumed.
 assert.equal(preferenceAnswer(label,{employerEmploymentDefault:'No'},{company:'Boeing'}),null);
 assert.equal(preferenceAnswer(label.replace('have you or','have you never or'),facts,{company:'Boeing'}),null);
 // Only the auditor pattern; an ordinary family-at-employer question is untouched by this rule.
 assert.equal(preferenceAnswer('Boeing engages Deloitte for consulting. Do you like audits?',facts,{company:'Boeing'}),null);
});
test('iRecruit bare "per:" pay-period select follows the annual salary rule, never for internships',()=>{
 const answers={salaryExpectationRule:{period:'annual',minimum:110000,midpointOrLower:110000}};
 assert.equal(preferenceAnswer('per:',answers,{role_type:'FULL_TIME'}).value,'Year');
 assert.equal(preferenceAnswer('per:',answers,{role_type:'INTERNSHIP'}),null);
 assert.equal(preferenceAnswer('per:',{salaryExpectationRule:{...answers.salaryExpectationRule,period:'hourly'}},{}),null);
 assert.equal(preferenceAnswer('per:',{},{}),null);
});

test('"desired salary or hourly rate" takes the annual salary rule for a full-time role (Henny Penny 13120)',()=>{
 const facts={salaryExpectationRule:{minimum:110000,midpointOrLower:110000,period:'annual'}};
 assert.equal(preferenceAnswer('What is your desired salary or hourly rate?',facts,{role_type:'FULL_TIME'})?.value,'110000');
 assert.equal(preferenceAnswer('What is your desired hourly rate?',facts,{role_type:'FULL_TIME'}),null);
 assert.equal(preferenceAnswer('What is your desired salary or hourly rate?',facts,{role_type:'INTERNSHIP'}),null);
});
