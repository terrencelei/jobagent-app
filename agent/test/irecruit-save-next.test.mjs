import test from 'node:test';
import assert from 'node:assert/strict';
import {safeNavigation,isFinalControl} from '../src/dashboard-worker.mjs';

// Piper Aircraft 13354: iRecruit moves between sections with "Save/Next"; the worker
// rejected it as an unknown button and parked the run on the first section.
test('iRecruit "Save/Next" is section navigation, not the final submit',()=>{
 const job={title:'Structural Analysis Engineer I',url:'https://www.irecruit-us.com/jobApplication.php'};
 for(const label of ['Save/Next','Save / Next','Save and Next','Save & Next']){
  assert.equal(safeNavigation(label,job),true,label);
  assert.equal(isFinalControl({type:'submit',label,inForm:true,formFields:20},[],job),false,label);
 }
 assert.equal(safeNavigation('Save',job),false);
 assert.equal(isFinalControl({type:'submit',label:'Submit Application',inForm:true,formFields:20},[],job),true);
});
