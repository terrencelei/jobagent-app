import test from 'node:test';
import assert from 'node:assert/strict';
import {appliedRoleQuestion,approvedValue,resolveKnownQuestion} from '../src/dashboard-worker.mjs';

const job={id:12207,company:'Shield AI',title:'Engineer I, Mechanical Hardware Test'};
const label='What full time job(s) are you applying for?';
const bank={'what full time job(s) are you applying for?':{question:label,answer:'Engineer I, Flight Test (R6219)',approvedFor:'10277'}};

test('the applied-for role is this posting, never another job\'s company-bank answer (Shield AI 12207)',()=>{
 assert.ok(appliedRoleQuestion(label));
 assert.ok(appliedRoleQuestion('Which position are you applying for?'));
 assert.ok(!appliedRoleQuestion('How did you hear about this position?'));
 const control={id:'c',label,type:'textarea',value:'Engineer I, Flight Test (R6219)'};
 assert.equal(approvedValue({},control,{answers:{}},bank,new Map(),job.company,job),job.title);
 assert.deepEqual(resolveKnownQuestion({question:{label},profile:{answers:{}},bank,job}),{resolved:true,value:job.title,fact:'job.title',usage:{}});
});

test('without a job title the applied-for role is not guessed',()=>{
 assert.throws(()=>approvedValue({},{id:'c',label,type:'textarea'},{answers:{}},bank,new Map(),'Shield AI',{}));
 assert.equal(resolveKnownQuestion({question:{label},profile:{answers:{}},bank,job:{}}).resolved,false);
});
