import test from 'node:test';
import assert from 'node:assert/strict';
import {profileFact} from '../src/profile-facts.mjs';

const options=['Please Select','Alabama','California','Virgin Islands, U.S.','Wyoming'];

test('a bare State select maps the saved address state code to its offered full name (Cisco 12281)',()=>{
 assert.deepEqual(profileFact('State\n*',{addressState:'CA'},{options}),{key:'addressState',value:'California',candidates:['California']});
 assert.equal(profileFact('State',{addressState:'CA'},{options:['CA','NY']}).value,'CA');
});

test('State is not answered without a saved state, without options, or when the state is not offered',()=>{
 assert.equal(profileFact('State *',{},{options}),null);
 assert.equal(profileFact('State *',{addressState:'CA'},{}),null);
 assert.equal(profileFact('State *',{addressState:'CA'},{options:['Ontario','Quebec']}),null);
 assert.equal(profileFact('State of licensure',{addressState:'CA'},{options}),null);
});

test('the regional location rule picks the offered full state name on a select (Cisco 12281)',async()=>{
 const {approvedValue}=await import('../src/dashboard-worker.mjs');
 const profile={answers:{applicationLocationRule:{defaultRegion:'bayArea',bayArea:{city:'Fixture City'}}}};
 const control={label:'State\n*',type:'select-one',options:options.map(label=>({label,value:label}))};
 assert.equal(approvedValue({action:'fill'},control,profile,{},new Map(),'Cisco',{company:'Cisco'}),'California');
 assert.equal(approvedValue({action:'fill'},{label:'State',type:'text'},profile,{},new Map(),'Cisco',{company:'Cisco'}),'CA');
});

test('Cisco phone device type and country phone code come from his saved phone facts (12281)',()=>{
 const codes=['Please Select','Afghanistan (+93)','Canada (+1)','United States (+1)','United States Minor Outlying Islands (+1)'];
 assert.equal(profileFact('Country Phone Code\n*',{phoneCountry:'United States +1'},{options:codes}).value,'United States (+1)');
 assert.equal(profileFact('Country Phone Code\n*',{phoneCountry:'United States +1'},{options:['Canada (+1)']}),null);
 assert.equal(profileFact('Country Phone Code\n*',{},{options:codes}),null);
 assert.equal(profileFact('Phone Device Type\n*',{phone:'x'},{options:['Please Select','Mobile','Landline']}).value,'Mobile');
 assert.equal(profileFact('Phone Device Type\n*',{},{options:['Mobile','Landline']}),null);
});

test('a Phenom select offering {label,value} options still settles phone device type from his saved phone (Genentech 14640)',async()=>{
 const {approvedValue}=await import('../src/dashboard-worker.mjs');
 const options=['select one','Alternative Phone','Landline','Mobile'].map(label=>({label,value:label}));
 const control={label:'Phone Device Type*',type:'select-one',options};
 assert.equal(approvedValue({action:'fill'},control,{answers:{phone:'x'}},{},new Map(),'Genentech',{company:'Genentech'}),'Mobile');
 assert.equal(profileFact('Phone Device Type*',{phone:'x'},{options}).value,'Mobile');
 assert.throws(()=>approvedValue({action:'fill'},control,{answers:{}},{},new Map(),'Genentech',{company:'Genentech'}));
});
