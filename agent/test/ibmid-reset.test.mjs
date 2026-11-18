import test from 'node:test';import assert from 'node:assert/strict';
import {ibmCode} from '../tools/ibmid-reset.mjs';
test('only a fresh 14-digit IBMid temporary code is taken from the mailbox reply',()=>{
 const after=Date.parse('2026-10-18T17:00:00Z')/1000;
 assert.equal(ibmCode('2026-10-18T17:05:00Z 12345678901234',after),'12345678901234');
 assert.equal(ibmCode('2026-10-18T17:05:00Z 462815',after),null,'a 6-digit number is not the reset code');
 assert.equal(ibmCode('2026-10-18T16:00:00Z 12345678901234',after),null,'older than the request');
 assert.equal(ibmCode('NONE',after),null);
});
