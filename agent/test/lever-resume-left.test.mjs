import test from 'node:test';
import assert from 'node:assert/strict';
import {uploadDocument} from '../src/dashboard-worker.mjs';

test('a resume left for him to attach is never uploaded, other documents still are (lesson 417)',()=>{
 assert.equal(uploadDocument('Resume/CV',null,{}),null);
 assert.deepEqual(uploadDocument('Resume/CV','/r.pdf',{}),{kind:'resume',path:'/r.pdf'});
 assert.deepEqual(uploadDocument('Unofficial transcript',null,{transcript:'/t.pdf'}),{kind:'transcript',path:'/t.pdf'});
});
