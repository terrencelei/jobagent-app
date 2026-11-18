import test from 'node:test';
import assert from 'node:assert/strict';
import {safeNavigation,isFinalControl} from '../src/dashboard-worker.mjs';

// Keel 12694: Paylocity's step 1 of 6 ends in <button type=submit>Next Step</button>.
// Treating it as the final Submit ran the pre-submit check on page one and failed the run.
test('Paylocity "Next Step" is navigation, not the final submit',()=>{
 const job={title:'Manufacturing Engineer I',url:'https://recruiting.paylocity.com/Recruiting/Jobs/Apply/4592667'};
 const next={type:'submit',label:'Next Step',inForm:true,formFields:30};
 assert.equal(safeNavigation(next.label,job),true);
 assert.equal(isFinalControl(next,[],job),false);
 assert.equal(isFinalControl({type:'submit',label:'Submit Application',inForm:true,formFields:30},[],job),true);
});
