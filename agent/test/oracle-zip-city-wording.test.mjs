import test from 'node:test';
import assert from 'node:assert/strict';
import {oracleWording} from '../src/dashboard-worker.mjs';

const answers={addressState:'CA',addressCity:'Springfield'};

test("Oracle's ZIP and City rows resolve from his saved address instead of going to Approvals",()=>{
 assert.equal(oracleWording(['95008, Springfield, Santa Clara, CA','95009, Springfield, Santa Clara, CA'],'95008',answers),'95008, Springfield, Santa Clara, CA');
 assert.equal(oracleWording(['Springfield, Santa Clara, CA','Springfield, Steuben, NY','Springfield, Wilkin, MN'],'Springfield',answers),'Springfield, Santa Clara, CA');
});

test('a ZIP listed under several place names takes the row naming his city; no guess without one',()=>{
 const rows=['95008, Springfield, Santa Clara, CA','95008, San Jose, Santa Clara, CA'];
 assert.equal(oracleWording(rows,'95008',answers),'95008, Springfield, Santa Clara, CA');
 assert.equal(oracleWording(rows,'95008',{addressState:'CA'}),null);
 assert.equal(oracleWording(['00501, Holtsville, Suffolk, NY','00544, Holtsville, Suffolk, NY'],'95008',answers),null);
});
