import test from 'node:test';
import assert from 'node:assert/strict';
import {salaryExpectation} from '../src/applicant-preferences.mjs';
import {approvedValue,resolveKnownQuestion} from '../src/dashboard-worker.mjs';
import {resolveQuestion} from '../src/workday.mjs';
import {questionId} from '../src/companies.mjs';
test('full-time annual expectations never become an internship hourly answer',()=>{
 const answers={salaryExpectationRule:{minimum:100000,midpointOrLower:120000}};
 const job={role_type:'INTERNSHIP',company:'Fixture'};
 const label='What is your desired hourly compensation?';
 const bank={[questionId(label)]:{question:label,answer:'100000'}};
 assert.equal(salaryExpectation(answers,{role_type:'FULL_TIME'}),'100000');
 assert.equal(salaryExpectation(answers,job),null);
 assert.equal(resolveKnownQuestion({question:{label,type:'text'},profile:{answers},bank,job}).resolved,false);
 assert.throws(()=>approvedValue({fact:'minimumAnnualSalary'},{label,type:'text'},{answers},bank,new Map(),job.company,job),/Internship compensation/);
 assert.equal(resolveQuestion(label,bank,{...job,answers}),null);
 assert.equal(approvedValue({}, {label,type:'text'},{answers},bank,new Map([[questionId(label),'40']]),job.company,job),'40');
 assert.deepEqual(resolveQuestion(label,bank,{...job,answers,approvedAnswers:[{question:label,answer:'40'}]}).candidates,['40']);
});
