import test from 'node:test';
import assert from 'node:assert/strict';
import {connectionQuestion} from '../src/answer-scope.mjs';
import {preferenceAnswer} from '../src/applicant-preferences.mjs';
import {approvedValue} from '../src/dashboard-worker.mjs';
import {questionId} from '../src/companies.mjs';

// Amazon 16221 (lesson 472): "... or related work?" is an experience question, not a relatives/connections one.
const amazon='Do you have experience in Design/Innovation, research & development, manufacturing, process, industrial engineering, or related work?';
const answers={employerConnectionsDefault:'No'};

test('"related work" experience questions are not employer-connection questions',()=>{
 assert.equal(connectionQuestion(amazon),false);
 assert.equal(connectionQuestion('Do you have experience in a related field or work environment?'),false);
 assert.equal(preferenceAnswer(amazon,answers),null);
 // Kinship wording still takes the saved default.
 assert.equal(connectionQuestion('Are you related to anyone employed by us?'),true);
 assert.equal(preferenceAnswer('Are you related to anyone employed by us?',answers).value,'No');
 assert.equal(connectionQuestion('Do you have relatives who work for the company?'),true);
});

test('the approved Yes for the Amazon experience question is filled, not the connections default',()=>{
 const bank={[questionId(amazon)]:{question:amazon,answer:'Yes'}};
 const control={id:'q1',label:amazon,type:'select-one',required:true,value:'No',options:[{label:'Yes',value:'Yes'},{label:'No',value:'No'}]};
 assert.equal(approvedValue({},control,{answers,confirmedFactSources:{employerConnectionsDefault:{recordedAt:'2026-11-01T00:00:00Z'}}},bank,new Map(),'Amazon.jobs',{company:'Amazon.jobs'}),'Yes');
});
