import test from 'node:test';import assert from 'node:assert/strict';
import {regionalProfile,locationRegion,regionalAnswer} from '../src/location-policy.mjs';
import {resolveKnownQuestion,approvedValue} from '../src/dashboard-worker.mjs';
import {resolveQuestion} from '../src/workday.mjs';
const profile={answers:{city:'Old City',addressLine1:'Old street',addressZip:'00000',applicationLocationRule:{defaultRegion:'bayArea',bayArea:{city:'Springfield'},southernCalifornia:{city:'Goleta',address:{addressLine1:'1 Fixture St',addressCity:'Goleta',addressState:'CA',addressZip:'90000'}}}}};
test('regional locations follow job city, not employer name or description',()=>{
 for(const location of ['Santa Clara, CA','San Francisco Bay Area','Sunnyvale, California'])assert.equal(locationRegion({location}),'bayArea');
 for(const location of ['El Segundo, CA','Goleta, CA','San Diego, California'])assert.equal(locationRegion({location}),'southernCalifornia');
 assert.equal(locationRegion({location:'New York, NY',company:'Bay Area Company'}),null);
 assert.equal(locationRegion({location:'San Jose, CA; Los Angeles, CA'}),null);
 assert.equal(regionalProfile(profile,{location:'Santa Clara, CA'}).answers.addressCity,'Springfield');
 assert.equal(regionalProfile(profile,{location:'Irvine, CA'}).answers.addressCity,'Goleta');
 assert.equal(profile.answers.addressLine1,'Old street');
});
test('regional facts override stale bank and inline answers without borrowing the other street address',()=>{
 const label='City',bank={city:{answer:'Old City'}},inline=new Map([['city','Old City']]);
 for(const [location,city] of [['Santa Clara, CA','Springfield'],['Los Angeles, CA','Goleta']]){
  const job={location};
  assert.equal(resolveKnownQuestion({question:{label},profile,bank,job}).value,city);
  assert.equal(approvedValue({}, {label,type:'text'},profile,bank,inline,'Example',job),city);
  assert.equal(resolveQuestion(label,bank,{...job,answers:profile.answers}).candidates[0],city);
 }
 const question={label:'Please provide your current address',type:'textarea'};
 assert.equal(resolveKnownQuestion({question,profile,bank:{'please provide your current address':{answer:'Old street'}},job:{location:'Santa Clara, CA'}}).resolved,false);
 assert.equal(resolveQuestion('Address Line 1',{}, {location:'Santa Clara, CA',answers:profile.answers}),null);
 assert.throws(()=>approvedValue({},question,profile,{},new Map(),'Example',{location:'Santa Clara, CA'}),/regional address/);
 assert.equal(regionalAnswer(question.label,profile,{location:'Los Angeles, CA'}).value,'1 Fixture St, Goleta, CA 90000');
 assert.equal(regionalProfile(profile,{location:'Santa Clara, CA'}).answers.addressZip,undefined);
});
test('iRecruit City/Town: with a non-breaking space takes the regional city (Piper 13343)',()=>{
 for(const label of ['City/Town:\u00a0*','City/Town *','City/Town:'])assert.equal(regionalAnswer(label,profile,{location:'Vero Beach, FL'}).value,'Springfield');
 assert.equal(regionalAnswer('City/Town:\u00a0*',profile,{location:'Goleta, CA'}).value,'Goleta');
});

test('Orange County and greater Los Angeles postings use the Southern California address (Howmet 11608, Fullerton)',()=>{
 for(const location of ['Fullerton, CA, United States','Huntington Beach, CA','Santa Clarita, California'])assert.equal(locationRegion({location}),'southernCalifornia');
 assert.equal(regionalAnswer('Address Line 1 *',profile,{location:'Fullerton, CA, United States'}).value,'1 Fixture St');
 assert.equal(regionalAnswer('Postal Code *',profile,{location:'Fullerton, CA, United States'}).value,'90000');
});
test("'Zip or Postal Code' takes the regional ZIP, not another region's banked postal code",()=>{
 // X-Bow 12727 (Luling, TX → default Bay Area) refilled the Goleta bank ZIP six times.
 const bank={'postal code':{answer:'90000'},'intent:postal-code':{answer:'90000'}},inline=new Map();
 const p={answers:{...profile.answers,applicationLocationRule:{...profile.answers.applicationLocationRule,bayArea:{city:'Springfield',address:{addressLine1:'2 Fixture Ct',addressCity:'Springfield',addressState:'CA',addressZip:'95000'}}}}};
 for(const label of ['Zip or Postal Code*','Postal or Zip Code']){
  assert.equal(regionalAnswer(label,p,{location:'Luling, TX'}).value,'95000');
  assert.equal(approvedValue({}, {label,type:'text'},p,bank,inline,'Example',{location:'Luling, TX'}),'95000');
 }
});
test("Oracle's 'Street Number and Name or P.O. Box' is the regional address line 1 (Ford 12635)",()=>{
 const job={location:'Long Beach, CA, United States'};
 for(const label of ['Street Number and Name or P.O. Box *','Street Number and Name or PO Box','Street Number and Name'])assert.equal(regionalAnswer(label,profile,job).value,'1 Fixture St');
 assert.equal(resolveKnownQuestion({question:{label:'Street Number and Name or P.O. Box *',type:'text',required:true},profile,bank:{},job}).value,'1 Fixture St');
 assert.equal(regionalAnswer('Street Number and Name or P.O. Box *',profile,{location:'Santa Clara, CA'}).value,undefined); // Bay Area has no saved street.
});
// Intuitive 12315 (lesson 429): SmartRecruiters asks "What is your postal code?" and "What is your State or Province?";
// neither matched the location wording, so the postal code came from the shared bank (another region's ZIP, beside the
// regional city) and the state went to the Approvals page although the rule settles it.
test("'What is your postal code?' and 'What is your State or Province?' take the regional ZIP and state",()=>{
 const job={company:'Example',location:'Irvine, CA'};
 assert.equal(regionalAnswer('What is your postal code? *',profile,job).value,'90000');
 assert.equal(regionalAnswer('What is your State or Province? *',profile,job).value,'CA');
 assert.equal(regionalAnswer('Please provide your current zip code',profile,job).value,'90000');
 assert.equal(regionalAnswer('What is your gender?',profile,job),undefined);
 // An unknown job location falls back to the default region, whose fixture has no street address.
 assert.equal(regionalAnswer('What is your postal code? *',profile,{location:'New York, NY'})?.value,undefined);
});
