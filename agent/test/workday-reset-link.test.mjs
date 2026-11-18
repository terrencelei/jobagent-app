import test from 'node:test';import assert from 'node:assert/strict';
import {resetLink,resetMailPrompt} from '../src/workday-mail.mjs';
const job='https://kla.wd1.myworkdayjobs.com/Search/job/Milpitas-CA/NPI_2641987';
test('only a fresh password reset link on the posting\'s own Workday host is used',()=>{
 const after=Date.parse('2026-10-18T07:00:00Z')/1000;
 assert.equal(resetLink('2026-10-18T07:05:00Z https://kla.wd1.myworkdayjobs.com/Search/passwordreset?token=abc',job,after),'https://kla.wd1.myworkdayjobs.com/Search/passwordreset?token=abc');
 assert.equal(resetLink('2026-10-18T07:05:00Z https://evil.example/Search/passwordreset?token=abc',job,after),null);
 assert.equal(resetLink('2026-10-18T06:00:00Z https://kla.wd1.myworkdayjobs.com/Search/passwordreset?token=old',job,after),null,'older than the request');
 assert.equal(resetLink('2026-10-18T07:05:00Z https://kla.wd1.myworkdayjobs.com/Search/activate/xyz',job,after),null,'activation links are not resets');
 assert.match(resetMailPrompt(job,after),/from:kla@otp\.workday\.com/);
});
