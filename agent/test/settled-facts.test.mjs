import test from 'node:test';
import assert from 'node:assert/strict';
import {settledAnswer,equivalentOption} from '../src/settled-facts.mjs';
import {approvedValue,resolveKnownQuestion} from '../src/dashboard-worker.mjs';
const answers={citizenshipCountries:['United States'],workAuthorizationCountries:['United States'],requiresSponsorship:false,currentSecurityClearance:'No',heldSecurityClearance:'No',clearanceEligibleYesNo:'Yes'};
test('reworded eligibility questions resolve even when the model asks',()=>{
 for(const [label,value] of [
  ['Are you a US citizen?','Yes'],['Please select your U.S. citizenship status','U.S. Citizen'],
  ['Do you have the legal right to work in the United States?','Yes'],
  ['Are you legally authorised to work in the USA without sponsorship?','Yes'],
  ['Will you now or in the future require visa sponsorship to work in the U.S.?','No'],
  ['Do you possess an active security clearance?','No'],
  ['Have you previously held security clearance?','No'],
  ['Which clearance level do you currently hold?','None'],
  ['Do you have the ability to secure a U.S. security clearance?','Yes'],
 ])assert.equal(approvedValue({action:'ask',fact:''},{label,type:'select-one'},{answers},{},new Map()),value,label);
});
test('job country supplies context only for an unspecified jurisdiction',()=>{
 assert.equal(settledAnswer('Are you authorized to work in this country?',answers,{location:'Austin, United States'}).value,'Yes');
 for(const label of ['Are you authorized to work in Canada?','Are you authorized to work in Germany?','Are you authorized to work in Atlantis?','Are you a UK citizen?'])assert.equal(settledAnswer(label,answers,{location:'United States'}),null,label);
 assert.equal(settledAnswer('Are you authorized to work?',answers),null);
});
test('different claims and missing facts still require an answer',()=>{
 for(const label of ['Are you a dual U.S. citizen?','Are you a U.S. citizen by birth?','Are you a U.S. citizen and willing to relocate?','Are you NOT a U.S. citizen?','Are you eligible to obtain Top Secret clearance?','Are you eligible to obtain Canadian clearance?','Will you obtain security clearance?','Has your clearance ever been revoked?'])assert.equal(settledAnswer(label,answers),null,label);
 assert.equal(settledAnswer('Are you a US citizen?',{}),null);
 assert.equal(settledAnswer('What level of clearance do you hold?',{currentSecurityClearance:'Yes'}),null);
});
test('dropdown synonyms preserve meaning and reject ambiguity',()=>{
 const profile={country:'United States',phoneCountry:'United States +1',city:'Example City, California, United States',citySearch:'Example City',discipline:'Engineering - Mechanical',major:'Mechanical Engineering',race:'East Asian',eeoRace:'Asian (Not Hispanic or Latino)'};
 assert.equal(equivalentOption('Discipline*',profile.discipline,['Mechanical Engineering','Electrical Engineering'],profile),'Mechanical Engineering');
 assert.equal(equivalentOption('Country*',profile.country,['United States +1'],profile),'United States +1');
 assert.equal(equivalentOption('Please identify your race*',profile.race,['Asian','White'],profile),'Asian');
 assert.equal(equivalentOption('Location (City)*',profile.citySearch,['Example City, California, United States','Example City, Other Country'],profile),profile.city);
 assert.equal(equivalentOption('Do you hold an active security clearance?','No',['Select','None','Secret'],answers),'None');
 assert.equal(equivalentOption('Are you a U.S. citizen?','Yes',['Select','US Citizen or National','Other'],answers),'US Citizen or National');
 assert.equal(equivalentOption('Are you a U.S. citizen?','Yes',['U.S. citizen by birth','Naturalized U.S. citizen'],answers),null);
 assert.equal(equivalentOption('Do you hold an active security clearance?','Yes',['None','Secret'],answers),null);
 assert.equal(equivalentOption('Do you hold an active security clearance?','No',['None','Not applicable'],answers),null);
});

test('confirmed U.S. phone-country options match equivalent country names with +1',()=>{
 const a={country:'United States',phoneCountry:'United States of America (+1)'};
 assert.equal(equivalentOption('Country*','United States',['United States +1','Canada +1'],a),'United States +1');
 assert.equal(equivalentOption('Country*','United States',['United States +44'],a),null);
});

test('the "No ... no clearance" patterns never match a Yes option',()=>{
 const yes=['Yes, I currently hold a SECRET or L Clearance','Yes, I currently hold a TOP SECRET or Q Clearance','Yes I have no issue obtaining a clearance','Yes, I do not have a clearance but can obtain one','Yes - I hold no other clearance','None','Not applicable; I hold an active clearance','Nope, I hold a clearance'];
 const no=['No I have no US Security Clearance or it was active longer than 2 years ago','No, I do not currently have an active security clearance'];
 for(const label of ['Do you currently hold an active security clearance?','Have you ever held a security clearance?','Security Clearance Status']){
  const patterns=settledAnswer(label,answers).candidates.filter(c=>c instanceof RegExp);
  assert.ok(patterns.length>=2,label);
  for(const o of yes)assert.ok(!patterns.some(p=>p.test(o)),`${label}: ${o}`);
  for(const o of no)assert.ok(patterns.some(p=>p.test(o)),`${label}: ${o}`);
 }
});

test('Lever export-control country follow-up takes N/A for a U.S. citizen', () => {
 const label='If you answered “No” to the above, please provide the country or countries of which you are a current citizen or national, and if applicable, where you are currently granted lawful permanent resident status. If you answered “Yes,” please enter N/A*';
 assert.equal(settledAnswer(label,{citizenshipCountries:['United States']})?.value,'N/A');
 assert.equal(settledAnswer(label,{citizenshipCountries:['Canada']}),null);
});
test('ITAR U.S. Person status picks U.S. citizen despite the preamble (True Anomaly 12996)',()=>{
 const label='The person hired will have access to information and items controlled by the International Traffic in Arms Regulation (ITAR). To conform to U.S. Government space technology export regulations, including the ITAR, you must be a U.S. citizen, lawful permanent resident of the U.S. (i.e., current Green Card holder), lawfully admitted into the U.S. as a refugee or granted asylum, or be eligible to obtain the required authorizations from the U.S. Department of State. Are you currently a U.S. Person as described above, or otherwise eligible to obtain the required authorization?*';
 const options=['U.S. citizen or national of the United States','U.S. lawful permanent resident (Green Card holder)','Refugee admitted under 8 U.S.C. § 1157','Asylee granted asylum under 8 U.S.C. § 1158','Not currently a U.S. Person / Other status'];
 assert.equal(resolveKnownQuestion({question:{label,type:'select',options,required:true},profile:{answers:{...answers,itarEligible:'Yes'}}}).value,options[0]);
 assert.equal(resolveKnownQuestion({question:{label:'Are you ITAR eligible (a U.S. person)?*',type:'select',options:['Yes','No'],required:true},profile:{answers:{...answers,itarEligible:'Yes'}}}).value,'Yes');
 assert.equal(settledAnswer(label,{citizenshipCountries:['Canada']}),null);
});
test('ITAR "If other, provide details" follow-up takes N/A for a U.S. citizen (True Anomaly 12996)',async()=>{
 const {preferenceAnswer}=await import('../src/applicant-preferences.mjs');
 const label='If other, please provide details as it relates to ITAR eligibility. Answer N/A if not applicable. *';
 assert.equal(settledAnswer(label,{citizenshipCountries:['United States']})?.value,'N/A');
 assert.equal(settledAnswer(label,{citizenshipCountries:['Canada']}),null);
 assert.equal(preferenceAnswer(label,{...answers,itarEligible:'Yes'})?.value,'N/A');
});

test('Karman DoD clearance multi-select: "I have never held a DoD security clearance" is a candidate (16537)', () => {
 const r=settledAnswer('Which option best describes the highest level and current status of any DoD security clearance eligibility you hold or previously held? *',{heldSecurityClearance:'No',currentSecurityClearance:'No',clearanceEligibleYesNo:'Yes'},{country:'United States'});
 const matches=o=>r.candidates.some(c=>c instanceof RegExp?c.test(o):c===o);
 assert.ok(matches('I have never held a DoD security clearance'));
 assert.ok(!matches('Inactive Secret')&&!matches('I’m not sure'));
});
