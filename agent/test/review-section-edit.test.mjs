import test from 'node:test';
import assert from 'node:assert/strict';
import {safeNavigation,isFinalControl,reviewSectionEdit} from '../src/dashboard-worker.mjs';

// Amazon 16220: the site resumed a saved draft straight at Review with a stale "No" answer. The guard refused
// "Edit Job-specific questions", so the run could not reopen the section to correct it.
test('a review page "Edit <section>" link is safe navigation, not a submit',()=>{
 const job={title:'Mechanical Project Engineer',url:'https://account.amazon.jobs/en-US/applicant/jobs/10552960/apply'};
 for(const label of ['Edit Job-specific questions','Edit Work eligibility','Edit Contact information','Edit resume'])
  assert.equal(safeNavigation(label,job),true,label);
 assert.equal(isFinalControl({type:'button',label:'Edit Job-specific questions',inForm:true,formFields:10},[],job),false);
});

test('other Edit controls stay refused',()=>{
 for(const label of ['Edit','Edit profile','Edit account settings','Edit and submit','Edit questions and submit application'])
  assert.equal(reviewSectionEdit(label),false,label);
});
