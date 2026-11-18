import test from 'node:test';
import assert from 'node:assert/strict';
import {safeNavigation,isFinalControl,profileStep} from '../src/dashboard-worker.mjs';
import {hintsFor} from '../src/site-hints.mjs';

test("iCIMS 'Update Profile' is a continue step, not the final Submit",()=>{
 const control={label:'Update Profile',type:'submit',formFields:14};
 assert.equal(profileStep(control.label),true);
 assert.equal(safeNavigation(control.label),true);
 assert.equal(isFinalControl(control,[{label:'City',value:'x'}]),false);
 assert.equal(profileStep('Submit Profile'),false);
 assert.equal(isFinalControl({label:'Submit',type:'submit',formFields:6},[{label:'City',value:'x'}]),true);
});

test('his iCIMS instruction is shown first on every iCIMS step, and nowhere else',async()=>{
 const hints=await hintsFor('https://us-careers-rivian.icims.com/jobs/1/candidate',{path:null});
 assert.equal(hints[0].id,'standing-icims-profile');
 assert.match(hints[0].text,/Update Profile.*Next at the bottom/);
 assert.deepEqual(await hintsFor('https://job-boards.greenhouse.io/x/jobs/1',{path:null}),[]);
});
