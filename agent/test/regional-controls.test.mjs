import test from 'node:test';
import assert from 'node:assert/strict';
import {regionalLocationCorrection} from '../src/regional-controls.mjs';
import {approvedValue} from '../src/dashboard-worker.mjs';

const profile={answers:{applicationLocationRule:{defaultRegion:'bayArea',bayArea:{city:'Springfield'},southernCalifornia:{city:'Goleta'}}}};
const control={id:'f0c2',label:'Current location',type:'text',combobox:true,inForm:true,value:'Springfield, CA, USA'};
const snapshot=c=>({frames:[{controls:[c]}]});

test('resume-populated Bay Area location is corrected for a Southern California role using the regional fact',()=>{
 const job={location:'Irvine, CA'};
 const selected=regionalLocationCorrection(snapshot(control),profile,job);
 assert.equal(selected,control);
 assert.equal(approvedValue({},selected,profile,{'current location':{answer:'Springfield, CA, USA'}},new Map(),'Example',job),'Goleta, California, United States');
 assert.equal(regionalLocationCorrection(snapshot({...control,value:'Goleta, CA, USA'}),profile,job),null);
 assert.equal(regionalLocationCorrection(snapshot({...control,value:'Goleta, California, United States'}),profile,job),null);
});

test('Bay Area roles retain Springfield and city fields use the confirmed city',()=>{
 assert.equal(regionalLocationCorrection(snapshot(control),profile,{location:'San Jose, CA'}),null);
 const city={...control,label:'City',combobox:false,value:'Goleta'};
 assert.equal(regionalLocationCorrection(snapshot(city),profile,{location:'Irvine, CA'}),null);
 assert.equal(regionalLocationCorrection(snapshot(city),profile,{location:'San Jose, CA'}),city);
});

test('unconfigured profiles and unrelated or non-editable fields are preserved',()=>{
 assert.equal(regionalLocationCorrection(snapshot(control),{answers:{}},{location:'Irvine, CA'}),null);
 for(const changes of [{label:'Preferred work location'},{label:'Current employer location'},{type:'file',combobox:false},{inForm:false},{label:'Current address'}]){
  assert.equal(regionalLocationCorrection(snapshot({...control,...changes}),profile,{location:'Irvine, CA'}),null);
 }
});

test('a regional correction the page did not keep is attempted once per control state (Lever clears a typed location on blur)',()=>{
 const job={location:'San Diego, CA'};
 const attempts=new Set();
 const lever={...control,combobox:false,domId:'location-input',value:''};
 assert.equal(regionalLocationCorrection(snapshot(lever),profile,job,attempts),lever);
 // Lever wiped the value when the next field took focus: the same empty control is not refilled.
 assert.equal(regionalLocationCorrection(snapshot(lever),profile,job,attempts),null);
 // A different page or control state is still corrected once.
 assert.equal(regionalLocationCorrection({url:'https://example.test/apply',frames:[{controls:[lever]}]},profile,job,attempts),lever);
 const stale={...lever,value:'Springfield, CA, USA'};
 assert.equal(regionalLocationCorrection(snapshot(stale),profile,job,attempts),stale);
 assert.equal(regionalLocationCorrection(snapshot(stale),profile,job,attempts),null);
 // Without a shared attempt set every call still returns the control.
 assert.equal(regionalLocationCorrection(snapshot(lever),profile,job),lever);
 assert.equal(regionalLocationCorrection(snapshot(lever),profile,job),lever);
});
