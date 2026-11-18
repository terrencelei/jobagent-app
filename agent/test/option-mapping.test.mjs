import test from 'node:test';
import assert from 'node:assert/strict';
import {mapConfirmedOption,usableOptions,optionSchema} from '../src/option-mapping.mjs';
import {resolveUnknownQuestion} from '../src/dashboard-worker.mjs';
import {resolveQuestion,pickOption,DEGREE_CANDIDATES} from '../src/workday.mjs';
import {sharedEligible} from '../src/companies.mjs';

const reply=(option,engine='claude')=>async(command,args,prompt)=>{
 const body=JSON.parse(engine==='codex'?prompt.slice(prompt.indexOf('{"question"')):prompt);
 assert.ok(body.offeredOptions.length&&body.confirmedAnswer);
 const out={option,fact:body.confirmedAnswer.key,reason:'same fact'};
 return {code:0,stderr:'',stdout:engine==='claude'?JSON.stringify({structured_output:out}):JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(out)}})};
};
const SNC=['Select One','Yes, I currently hold a SECRET or L Clearance','Yes, I currently hold a TOP SECRET or Q Clearance','No I have no US Security Clearance or it was active longer than 2 years ago'];

test('placeholders never reach the agent and the schema enumerates offered options',()=>{
 assert.deepEqual(usableOptions(['Select One','BS','BS','MS']),['BS','MS']);
 assert.deepEqual(optionSchema(['BS']).properties.option.enum,['BS','']);
});
for(const engine of ['claude','codex'])test(`${engine} maps a confirmed answer onto the employer's wording`,async()=>{
 const r=await mapConfirmedOption({label:'Field of Study',options:['Mechanical','Applied Mechanics'],confirmed:{key:'education.0.field',value:'Mechanical Engineering'},engine,command:'x',execImpl:reply('Mechanical',engine)});
 assert.deepEqual([r.resolved,r.value],[true,'Mechanical']);
});
test('an option the employer did not offer, or an empty choice, is rejected',async()=>{
 for(const option of ['Mechanical Engineering','','Select One'])
  assert.equal((await mapConfirmedOption({label:'Field of Study',options:['Select One','Mechanical'],confirmed:{key:'k',value:'Mechanical Engineering'},execImpl:reply(option)})).resolved,false);
 assert.equal((await mapConfirmedOption({label:'Degree',options:['BS'],confirmed:{key:'k',value:'x'},execImpl:async()=>{throw new Error('down');}})).resolved,false);
});
test('a confirmed answer worded differently is mapped instead of sent to Approvals',async()=>{
 const r=await resolveUnknownQuestion({question:{label:'Clearance Level',options:['Select One','Secret','Top Secret','Not currently cleared']},profile:{answers:{currentSecurityClearance:'No',heldSecurityClearance:'No'}},bank:{},job:{company:'Fixture'},engine:'claude',command:'x',execImpl:reply('Not currently cleared')});
 assert.equal(r.resolved,true);assert.equal(r.value,'Not currently cleared');
});
test('Draper BS, Micron degree and SNC clearance wording resolve without the agent',()=>{
 const ctx={answers:{degree:"Bachelor's Degree",currentSecurityClearance:'No',heldSecurityClearance:'No'},history:[]};
 assert.equal(pickOption(['Select One','BA','BS','MS'],resolveQuestion('Degree',{},ctx).candidates),'BS');
 assert.equal(pickOption(['Select One','BA','BS','MS'],DEGREE_CANDIDATES),'BS');
 assert.equal(pickOption(SNC,resolveQuestion('Do you currently hold a security clearance?',{},ctx).candidates),SNC[3]);
});
test('education-row answers are never learned for every employer',()=>{
 for(const q of ['Degree','Field of Study','Field of Study (Statistics and Data Science)','School or University'])assert.equal(sharedEligible(q,'BS','Draper'),false);
 assert.equal(sharedEligible('Are you at least 18 years of age?','Yes','Draper'),true);
});
