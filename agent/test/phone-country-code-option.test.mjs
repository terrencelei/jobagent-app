import test from 'node:test';import assert from 'node:assert/strict';
import {profileFact} from '../src/profile-facts.mjs';
// Intuitive 12316 (SmartRecruiters, lesson 417): the Country code menu lists bare country names, never "+1".
test('a name-only country code menu resolves from the saved phone country, with the code forms as candidates',()=>{
 const answers={phone:'555-555-0100',phoneCountry:'United States +1'};
 const fact=profileFact('Country code',answers,{options:['Afghanistan','United Kingdom','United States','Uruguay']});
 assert.equal(fact?.value,'United States');
 assert.deepEqual(fact.candidates,['United States','+1','United States +1']);
 const coded=profileFact('Country code',answers,{options:['United Kingdom +44','United States +1']});
 assert.equal(coded?.value,'United States +1');assert.ok(coded.candidates.includes('+1'));
 assert.equal(profileFact('Country code',answers,{options:['United Kingdom','Uruguay']}),null);
});
